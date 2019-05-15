/*
   Copyright 2016 Graham Lee Bevan <graham.bevan@ntlworld.com>

   Based upon work:
      https://github.com/mongodb-js/connect-mongodb-session
      (Apache 2.0 License)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

/*jslint node: true, esversion: 6 */
'use strict';

// refered to https://github.com/mongodb-js/connect-mongodb-session/blob/master/index.js during dev

const console = require('better-console');
const arangojs = require('arangojs');
const EventEmitter = require('events').EventEmitter;
const Q = require('q');
const assert = require('assert');
const _ = require('lodash');
const url = require('url');

Q.longStackSupport = true;

const init = function (connect) {
  var Store = connect.Store || connect.session.Store;
  var defaults = {
    url: 'http://localhost:8529',
    collection: 'sessions',
    connectionOptions: {},
    expires: 1000 * 60 * 60 * 24 * 14, // 2 weeks
    idField: '_key'
  };

  class ArangoDBStore {

    constructor (options, callback) {
      let self = this;

      assert(options, 'options not provided');
      assert(typeof options === 'object', 'options is now an object');
      assert(options.url, 'url not provided');
      assert(options.dbName, 'dbName not provided');

      self._emitter = new EventEmitter();
      self._errorHandler = self.handleError.bind(this);

      _.merge(defaults, options);

      Store.call(self, defaults);
      self.options = defaults;

      self.db = arangojs({
        url: options.url,
        databaseName: options.dbName,
        promise: Q.promise
      });

      if(options.user && options.password){
        self.db.useBasicAuth(options.user, options.password);
      }

      self.db.listUserDatabases()
          .then(function (databases) {

            // Test if db exists
            let dbExists = (databases.filter(function (d) {
              return d === self.options.dbName;
            }).length > 0);

            if (!dbExists) {
              // Create the database
              return self.db.createDatabase(self.options.dbName)
                  .then(function(info) {
                    self.db.useDatabase(self.options.dbName);
                  });
            } else {
              self.db.useDatabase(self.options.dbName);
              return Q();
            }
          })
          .done(function () {
            self.collection = self.db.collection(self.options.collection);

            self.db.listCollections()
                .then(function (collections) {
                  let colExists = false;

                  if (collections) {
                    colExists = (collections.filter(function (d) {
                      return d.name === self.options.collection;
                    }).length > 0);
                  }

                  if (colExists) {
                    return callback();
                  } else {
                    self.collection.create()
                        .then(function () {
                          return callback();
                        });
                  }
                });
          }, function(err) {
            console.warn('Failed to talk to ArangoDB, maybe the service isn\'t running?:', err);

          });
    }

    handleError(error, callback) {
      if (this._emitter.listeners('error').length) {
        this._emitter.emit('error', error);
      }

      if (callback) {
        callback(error);
      }

      if (!this._emitter.listeners('error').length && !callback) {
        throw error;
      }
    }

  }

  _.mixin(ArangoDBStore.prototype, Store.prototype);

  ArangoDBStore.prototype._generateQuery = function(id) {
    var ret = {};
    ret[this.options.idField] = id;
    return ret;
  };

  ArangoDBStore.prototype.get = function(id, callback) {
    var self = this;

    if (!self.db) {
      return this._emitter.once('connected', function () {
        self.get.call(self, id, callback);
      });
    }

    self.collection.byExample(self._generateQuery(id), function(error, cursor) {
      if (error) {
        var e = new Error('Error finding ' + id + ': ' + error.message);
        return self._errorHandler(e, callback);
      }
      if (cursor.count > 1) {
        var err = new Error('get byExample returned more than 1 result');
        console.error(err);
        return callback(err);
      }
      if (cursor.count === 1) {
        cursor.next()
            .then(function (session) {
              if (session) {
                if (!session.expires || new Date() < new Date(session.expires)) {
                  return callback(null, session.session);
                } else {
                  return self.destroy(id, callback);
                }
              } else {
                return callback();
              }
            });
      } else {
        return callback();
      }
    });
  };

  ArangoDBStore.prototype.destroy = function(id, callback) {
    var self = this;
    if (!this.db) {
      return this._emitter.once('connected', function() {
        self.destroy.call(self, id, callback);
      });
    }

    self.collection
        .removeByExample(this._generateQuery(id), function(error) {
          if (error) {
            var e = new Error('Error destroying ' + id + ': ' + error.message);
            return self._errorHandler(e, callback);
          }
          if (callback) {
            callback();
          }
        });
  };

  ArangoDBStore.prototype.clear = function(callback) {
    var self = this;
    if (!this.db) {
      return this._emitter.once('connected', function() {
        self.clear.call(self, callback);
      });
    }

    self.collection
        .removeByExample({}, function(error) {
          if (error) {
            var e = new Error('Error clearing all sessions: ' + error.message);
            return self._errorHandler(e, callback);
          }
          if (callback) {
            callback();
          }
        });
  };

  ArangoDBStore.prototype.set = function(id, session, callback) {
    var self = this;

    if (!this.db) {
      return this._emitter.once('connected', function() {
        self.set.call(self, id, session, callback);
      });
    }

    var sess = {};
    for (var key in session) {
      if (key === 'cookie') {
        sess[key] = session[key].toJSON ? session[key].toJSON() : session[key];
      } else {
        sess[key] = session[key];
      }
    }

    var s = this._generateQuery(id);
    s.session = sess;
    if (session && session.cookie && session.cookie.expires) {
      s.expires = new Date(session.cookie.expires);
    } else {
      var now = new Date();
      s.expires = new Date(now.getTime() + this.options.expires);
    }

    // upsert
    self.collection.byExample(this._generateQuery(id))
        .then(function (cursor) {
          if (cursor.count > 1) {
            var err = new Error('queryOne returned more than 1 result');
            console.error(err);
            return callback(err);
          }
          if (cursor.count === 1) {
            cursor.next()
                .then(function (existing_doc) {
                  s._key = existing_doc._key;
                  self.collection.update({_key: s._key}, s)
                      .then(function () {
                        return callback();
                      }, function (err) {
                        console.error(err);
                        return callback(err);
                      });
                });
          } else {
            self.collection.save(s);
            return callback();
          }
        });

  };

  ArangoDBStore.prototype.on = function() {
    this._emitter.on.apply(this._emitter, arguments);
  };

  ArangoDBStore.prototype.once = function() {
    this._emitter.once.apply(this._emitter, arguments);
  };

  return ArangoDBStore;
};

module.exports = init;