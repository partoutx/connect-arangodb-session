# connect-arangodb-session

[ArangoDB](https://www.arangodb.com/) database backed session store for Express (only tested on Express 4).

# API

## ArangoDBStore
e.g.:
```
var express = require('express');
var session = require('express-session');
var ArangoDBStore = require('connect-arangodb-session')(session);

var app = express();
var store = new ArangoDBStore({
  url: 'http://localhost:8529',
  dbName: 'mydb',
  collection: 'sessions',
});

app.use(expressSession({
  secret: 'SECRET',
  store: store
}));

```
