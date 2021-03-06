/**
 * Module Dependencies
 */
var async = require('async'),
    _ = require('lodash'),
    db2 = require('ibm_db'),
    adapterErrors = require('waterline-errors').adapter;

/**
 * Sails Boilerplate Adapter
 *
 * Most of the methods below are optional.
 *
 * If you don't need / can't get to every method, just implement
 * what you have time for.  The other methods will only fail if
 * you try to call them!
 *
 * For many adapters, this file is all you need.  For very complex adapters, you may need more flexiblity.
 * In any case, it's probably a good idea to start with one file and refactor only if necessary.
 * If you do go that route, it's conventional in Node to create a `./lib` directory for your private submodules
 * and load them at the top of the file with other dependencies.  e.g. var update = `require('./lib/update')`;
 */
var modul = (function (adapterOptions) {
    var me = this;

    // default options
    var defaultAdapterOptions = {
        // quoting table names makes them case-sensitive
        quoteTableNames: false,
        // default type for PK columns
        defaultPrimaryKeyType: 'INTEGER',
        // logger function or null
        logger: null
    };
    if (_.isUndefined(adapterOptions)) {
        adapterOptions = {};
    }
    _.forOwn(defaultAdapterOptions, function (val, key) {
        if (_.isUndefined(adapterOptions[key])) {
            adapterOptions[key] = val;
        }
    });


    // You'll want to maintain a reference to each collection
    // (aka model) that gets registered with this adapter.
    me.connections = {};


    // You may also want to store additional, private data
    // per-collection (esp. if your data store uses persistent
    // connections).
    //
    // Keep in mind that models can be configured to use different databases
    // within the same app, at the same time.
    //
    // i.e. if you're writing a MariaDB adapter, you should be aware that one
    // model might be configured as `host="localhost"` and another might be using
    // `host="foo.com"` at the same time.  Same thing goes for user, database,
    // password, or any other config.
    //
    // You don't have to support this feature right off the bat in your
    // adapter, but it ought to get done eventually.
    //
    // Sounds annoying to deal with...
    // ...but it's not bad.  In each method, acquire a connection using the config
    // for the current model (looking it up from `_modelReferences`), establish
    // a connection, then tear it down before calling your method's callback.
    // Finally, as an optimization, you might use a db pool for each distinct
    // connection configuration, partioning pools for each separate configuration
    // for your adapter (i.e. worst case scenario is a pool for each model, best case
    // scenario is one single single pool.)  For many databases, any change to
    // host OR database OR user OR password = separate pool.
    me.dbPools = {};

    me.getConnectionString = function (connection) {
        var connectionData = [
            'DRIVER={DB2}',
            'DATABASE=' + connection.config.database,
            'HOSTNAME=' +  connection.config.host,
            'UID=' +  connection.config.user,
            'PWD=' +  connection.config.password,
            'PORT=' +  connection.config.port,
            'PROTOCOL=TCPIP'
        ];

        return connectionData.join(';');
    };


    me.escape = function (word) {
        return "'" + word.replace("'", "''") + "'";
    };


    me.formatTableName = function (tableName) {
        return adapterOptions.quoteTableNames
             ? '"' + tableName.replace('"', '""') + '"'
            : tableName;
    };


    var logQuery = function (query) {
        if (typeof adapterOptions.logger === 'function') {
            adapterOptions.logger(query);
        }
        return query;
    };


    // returns FETCH ONLY clause; use this for non-SELECT statements
    var getFetchOnly = function(rowsNumber) {
        if (typeof rowsNumber === 'number' && rowsNumber > 0) {
            return ' FETCH FIRST ' + rowsNumber + ' ROWS ONLY ';
        } else {
            return '';
        }
    };


    // map DB2 types to Waterline types
    // Waterline source: https://www.npmjs.org/package/waterline#attributes
    // IBM DB2 source: http://publib.boulder.ibm.com/infocenter/dzichelp/v2r2/index.jsp?topic=%2Fcom.ibm.db2z9.doc.sqlref%2Fsrc%2Ftpc%2Fdb2z_datatypesintro.htm
    me.typeMap = {
        // Times
        TIMESTAMP: 'datetime',
        TIME: 'time',
        DATE: 'date',

        // Binaries
        BINARY: 'binary',
        VARBINARY: 'binary',
        BLOB: 'binary',
        GRAPHIC: 'binary',
        VARGRAPHIC: 'binary',

        // Strings
        CHARACTER: 'string',
        CHAR: 'string',
        VARCHAR: 'string',

        // Integers
        SMALLINT: 'integer',
        INTEGER: 'integer',
        INT: 'integer',
        BIGINT: 'integer',

        // Floats
        DECIMAL: 'float',
        NUMERIC: 'float',
        DECFLOAT: 'float',
        REAL: 'float',
        DOUBLE: 'float',

        // Texts
        CLOB: 'text',
        DBCLOB: 'text',
        XML: 'text'
    };

    // maps Waterline types to DB2 types
    me.getSqlType = function (attrType) {
        var type = '';

        switch (attrType) {
            case 'string':
                type = 'VARCHAR';
                break;
            case 'integer':
                type = 'INTEGER';
                break;
            case 'float':
                type = 'DOUBLE';
                break;
            case 'text':
                type = 'CLOB';
                break;
            case 'binary':
                type = 'VARBINARY';
                break;
            case 'datetime':
                type = 'TIMESTAMP';
                break;
            case 'time':
                type = 'TIME';
                break;
            case 'date':
                type = 'DATE'
                break;
        }

        return type;
    };

    me.getSelectAttributes = function (collection) {
        return _.keys(collection.definition).join(',');
    };

    var adapter = {
        identity: 'sails-db2',

        // Set to true if this adapter supports (or requires) things like data types, validations, keys, etc.
        // If true, the schema for models using this adapter will be automatically synced when the server starts.
        // Not terribly relevant if your data store is not SQL/schemaful.
        syncable: true,


        // Default configuration for collections
        // (same effect as if these properties were included at the top level of the model definitions)
        defaults: {
            host: 'localhost',
            port: 50000,
            schema: true,
            ssl: false,

            // If setting syncable, you should consider the migrate option,
            // which allows you to set how the sync will be performed.
            // It can be overridden globally in an app (config/adapters.js)
            // and on a per-model basis.
            //
            // IMPORTANT:
            // `migrate` is not a production data migration solution!
            // In production, always use `migrate: safe`
            //
            // drop   => Drop schema and data, then recreate it
            // alter  => Drop/add columns as necessary.
            // safe   => Don't change anything (good for production DBs)
            migrate: 'safe'
        },


        /**
         *
         * Open DB2 connection
         * This method runs when a model is initially registered
         * at server-start-time.  This is the only required method.
         *
         * @param  {[type]}   collection [description]
         * @param  {Function} cb         [description]
         * @return {[type]}              [description]
         */
        registerConnection: function (connection, collections, cb) {
            // Validate arguments
            if (!connection.identity) return cb(adapterErrors.IdentityMissing);
            if (me.connections[connection.identity]) return cb(adapterErrors.IdentityDuplicate);

            me.connections[connection.identity] = {
                config: connection,
                collections: collections,
                pool: connection.pool ? new db2.Pool() : null,
                conn: null
            };

            return cb();
        },


        /**
         * Kill DB2 connection
         * Fired when a model is unregistered, typically when the server
         * is killed. Useful for tearing-down remaining open connections,
         * etc.
         *
         * @param  {Function} cb [description]
         * @return {[type]}      [description]
         */
        teardown: function (connectionName, cb) {
            var closeConnection = function (connectionName) {
                var connection = me.connections[connectionName];
                if (connection.conn) connection.conn.close();

                delete me.connections[connectionName];
            };

            if (connectionName) closeConnection(connectionName);
            else _.each(me.connections, closeConnection);

            return cb();
        },


        /**
         *
         * Create a table in DB2.
         * REQUIRED method if integrating with a schemaful
         * (SQL-ish) database.
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   definition     [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        define: function (connectionName, collectionName, definition, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                query = 'CREATE TABLE ' + me.formatTableName(collectionName),
                schemaData = [],
                schemaQuery = '';

            _.each(definition, function (attribute, attrName) {
                var attrType = me.getSqlType(attribute.type),
                    attrQuery = attrName;

                // @todo: check SYSCAT or IBMSYS to find primary keys and UNIQUE indexes
                if (attribute.primaryKey) {
                    if (attribute.autoIncrement) attrQuery += adapterOptions.defaultPrimaryKeyType + ' GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
                    else attrQuery += ' ' + adapterOptions.defaultPrimaryKeyType + ' NOT NULL PRIMARY KEY';
                } else {
                    // @todo: add type-dependent column attributes?
                    // same default sizes as DB2
                    var defaultLen = null;
                    switch (attrType) {
                        case 'GRAPHIC':
                        case 'CHAR':
                        case 'CHARACTER':
                        case 'BINARY':
                            defaultLen = 1;
                            break;
                        case 'VARCHAR':
                        case 'VARBINARY':
                            defaultLen = 32704;
                            break;
                        case 'CLOB': // depends on charset; use max len
                            defaultLen = 2147483647;
                            break;
                        case 'BLOB':
                            defaultLen = 1024;
                            break;
                        case 'DBCLOB':
                            defaultLen = 512;
                            break;
                        default:
                            // no size should or can be specified
                            attrQuery += ' ' + attrType;
                    }
                    if (!attribute.length && defaultLen !== null) {
                        attribute.length = defaultLen;
                    }
                    if (!!attribute.length) {
                        attrQuery += ' ' + attrType + '(' + attribute.length + ')';
                    }
                    attrQuery += (attribute.required ? ' NOT NULL' : 'WITH DEFAULT');
                }

                schemaData.push(attrQuery);
            });
            schemaQuery += '(' + schemaData.join(',') + ')';

            query += ' ' + schemaQuery;
            logQuery(query);
            
            // @todo: use DB2 Database describe method instead of a SQL Query
            return adapter.query(connectionName, collectionName, query, function (err, result) {
                if (err) {
                    if (err.state.substring(0, 1) !== '01') return cb(err);
                    result = [];
                }

                return cb(null, result);
            });
        },

        /**
         *
         * Query system tables for a table definition and creates a Waterline collection.
         * REQUIRED method if integrating with a schemaful
         * (SQL-ish) database.
         *
         * @param  {[type]}   collectionName [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        describe: function (connectionName, collectionName, cb) {
            // @todo: we should read ROWID from db, and never update it.
            // It's more reliable than PK's because it always exists and is only 1 column.
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                query = 'SELECT COLNAME, TYPENAME, LENGTH, NULLS, DEFAULT, IDENTITY'
                    + ' FROM SYSCAT.COLUMNS'
                    + ' WHERE TABSCHEMA = (CURRENT SCHEMA) AND TABNAME = ' + me.escape(collectionName)
                    + ' ORDER BY COLNO';
            logQuery(query);

            // @todo: use DB2 Database describe method instead of a SQL Query
            adapter.query(connectionName, collectionName, query, function (err, attrs) {
                if (err) return cb(err);
                if (attrs.length === 0) return cb(null, null);

                var attributes = {};
                // Loop through Schema and attach extra attributes
                // @todo: check out a better solution to define primary keys following db2 docs
                attrs.forEach(function (attr) {
                    var attribute = {
                        type: me.typeMap[attr.TYPENAME.trim()],
                        maxLength: attr.LENGTH,
                        required: ((isNaN(attr.DEFAULT) || attr.DEFAULT === 0) && attr.NULLS === 'N')
                    };

                    // @todo: handle multi-column keys
                    if (attr.IDENTITY === 'Y') {
                        attribute.primaryKey = true;
                        attribute.autoIncrement = true;
                        attribute.unique = true;
                    }

                    attributes[attr.COLNAME] = attribute;
                });

                cb(null, attributes);
            });
        },


        /**
         *
         * DROP TABLE
         * REQUIRED method if integrating with a schemaful
         * (SQL-ish) database.
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   relations      [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        drop: function (connectionName, collectionName, relations, cb) {
            if (_.isFunction(relations)) {
                cb = relations;
                relations = [];
            }

            var connection = me.connections[connectionName],
                connectionString = me.getConnectionString(connection),
                __DROP__ = function () {
                    // Drop any relations
                    var dropTable = function (tableName, next) {
                        // Build query
                        var query = 'DROP TABLE ' + me.formatTableName(tableName);

                        // Run query
                        connection.conn.query(query, next);
                    },
                    passCallback = function (err, result) {
                        if (err) {
                            if (err.state.substring(0, 1) !== '01') return cb(err);
                            result = [];
                        }
                        cb(null, result);
                    };

                    async.eachSeries(relations, dropTable, function(err) {
                        if (err) return cb(err);
                        return dropTable(collectionName, passCallback);
                    });

                    logQuery(query);
                    connection.conn.query('DROP TABLE ' + collectionName, relations, passCallback);
                },
                operationCallback = function (err, conn) {
                    if (err) return cb(err);
                    else {
                        connection.conn = conn;
                        return __DROP__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },


        // OVERRIDES NOT CURRENTLY FULLY SUPPORTED FOR:
        //
        // alter: function (collectionName, changes, cb) {},
        // addAttribute: function(collectionName, attrName, attrDef, cb) {},
        // removeAttribute: function(collectionName, attrName, attrDef, cb) {},
        // alterAttribute: function(collectionName, attrName, attrDef, cb) {},
        // addIndex: function(indexName, options, cb) {},
        // removeIndex: function(indexName, options, cb) {},

        query: function (connectionName, collectionName, query, data, cb) {
            if (_.isFunction(data)) {
                cb = data;
                data = null;
            }

            var connection = me.connections[connectionName],
                connectionString = me.getConnectionString(connection),
                __QUERY__ = function () {
                    var callback = function (err, records) {
                        if (err) {
                            cb(err);
                        } else {
                            // lack of error could be enough,
                            // but i prefer to be sure that the query has been issued
                            cb(null, records);
                        }
                    };

                    // with or without parameters (WHERE x = ?)
                    if (data) connection.conn.query(query, data, callback);
                    else      connection.conn.query(query, callback);
                },
                operationCallback = function (err, conn) {
                    if (err) {
                            cb(err);
                    } else {
                        connection.conn = conn;
                        return __QUERY__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },

        /**
         *
         * SELECT
         * options: objects representing various SELECT clauses.
         *
         * REQUIRED method if users expect to call Model.find(), Model.findOne(),
         * or related.
         *
         * You should implement this method to respond with an array of instances.
         * Waterline core will take care of supporting all the other different
         * find methods/usages.
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   options        [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        find: function (connectionName, collectionName, options, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                connectionString = me.getConnectionString(connection),
                // @todo: fields, groupBy, having, count, sum, min, max, average, median, stddev, variance, covariance
                __FIND__ = function () {
                    var selectClause = (typeof options.select !== 'undefined')
                            ? options.select.join(',') : me.getSelectAttributes(collection),
                        distinctOption = (options.distinct == true)
                                ? 'DISTINCT ' : '',
                        fromQuery = ' FROM ' + me.formatTableName(collection.tableName),
                        whereData = [],
                        whereQuery = '',
                        limitQuery = options.limit ? ' LIMIT ' + options.limit : '',
                        skipQuery = options.skip ? ' OFFSET ' + options.skip : '',
                        sortData = [],
                        sortQuery = '',
                        params = [],
                        sqlQuery = '';

                    // validate query
                    if (options.skip && !options.limit) {
                        throw new Error('Cannot specify .skip without .limit');
                    }
                    
                    // Building where clause
                    _.each(options.where, function (param, column) {
                        if (collection.definition.hasOwnProperty(column)) {
                            whereData.push(column + ' = ?');
                            params.push(param);
                        }
                    });
                    if (whereData.length > 0) whereQuery = ' WHERE ' + whereData.join(' AND ');

                    // Building sort clause
                    _.each(options.sort, function (direction, column) {
                        if (collection.definition.hasOwnProperty(column)) {
                            // {colName: 'DESC'} -> ORDER BY <col_name> [ASC | DESC]
                            sortData.push(column + ' ' + direction);
                        }
                    });
                    if (sortData.length > 0) sortQuery = ' ORDER BY ' + sortData.join(', ');

                    // assemble clauses
                    sqlQuery = 'SELECT ' + distinctOption + selectClause + fromQuery
                        + whereQuery + sortQuery + limitQuery + skipQuery;
                    logQuery(sqlQuery);
                    connection.conn.query(sqlQuery, params, cb);

                    // Options object is normalized for you:
                    //
                    // options.where
                    // options.limit
                    // options.skip
                    // options.sort

                    // Filter, paginate, and sort records from the datastore.
                    // You should end up w/ an array of objects as a result.
                    // If no matches were found, this will be an empty array.
                },
                operationCallback = function (err, conn) {
                    if (err) return cb(err);
                    else {
                        connection.conn = conn;
                        return __FIND__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },

        /**
         *
         * SELECT - 1 row
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   options        [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        findOne: function (connectionName, collectionName, options, cb) {
            options.limit = 1;
            return this.find(connectionName, collectionName, options, cb);
        },

        /**
         *
         * SELECT COUNT(*)
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   options        [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        count: function (connectionName, collectionName, options, cb) {
            options.select = ['COUNT(*)'];
            return this.find(connectionName, collectionName, options, cb);
        },

        /**
         *
         * INSERT
         * REQUIRED method if users expect to call Model.create() or any methods
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   values         [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        create: function (connectionName, collectionName, values, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                connectionString = me.getConnectionString(connection),
                __CREATE__ = function () {
                    var
                        // in case ORM columns are a subset of DB2 columns
                        selectQuery = me.getSelectAttributes(collection),
                        query = '',
                        columns = [],
                        params = [],
                        questions = [];

                    _.each(values, function (param, column) {
                        // INTO and VALUES clauses, with ? placeholders
                        if (collection.definition.hasOwnProperty(column)) {
                            columns.push(column);
                            params.push(param);
                            questions.push('?');
                        }
                    });

                    query = 'SELECT ' + selectQuery + ' FROM FINAL TABLE (INSERT INTO ' + me.formatTableName(collection.tableName) + ' (' + columns.join(',') + ') VALUES (' + questions.join(',') + '))';
                    logQuery(query);
                    connection.conn.query(query, params, function (err, results) {
                        if (err) {
                            cb(err);
                        } else {
                            cb(null, results[0]);
                        }
                    });
                },
                operationCallback = function (err, conn) {
                    if (err) return cb(err);
                    else {
                        connection.conn = conn;
                        return __CREATE__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },


        /**
         *
         * UPDATE
         * REQUIRED method if users expect to call Model.update()
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   options        [description]
         * @param  {[type]}   values         [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        update: function (connectionName, collectionName, options, values, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                connectionString = me.getConnectionString(connection),
                __UPDATE__ = function () {
                    var selectQuery = me.getSelectAttributes(collection),
                        setData = [],
                        setQuery = '',
                        whereData = [],
                        whereQuery = '',
                        params = [],
                        query = '';

                    _.each(values, function (param, column) {
                        if (collection.definition.hasOwnProperty(column) && !collection.definition[column].autoIncrement) {
                            setData.push(column + ' = ?');
                            params.push(param);
                        }
                    });
                    setQuery += setData.join(',');

                    _.each(options.where, function (param, column) {
                        if (collection.definition.hasOwnProperty(column)) {
                            whereData.push(column + ' = ?');
                            params.push(param);
                        }
                    });
                    whereQuery = whereData.join(' AND ');

                    if (whereQuery.length > 0) whereQuery = ' WHERE ' + whereQuery;

                    query = 'SELECT ' + selectQuery + ' FROM FINAL TABLE ('
                        + 'UPDATE ' + me.formatTableName(collection.tableName)
                        + ' SET ' + setQuery + whereQuery + getFetchOnly(options.limit)
                        + ')';
                    logQuery(query);
                    connection.conn.query(query, params, function (err, results) {
                        if (err) cb(err);
                        else cb(null, results[0]);
                    });
                },
                operationCallback = function (err, conn) {
                    if (err) return cb(err);
                    else {
                        connection.conn = conn;
                        return __UPDATE__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },

        /**
         *
         * DELETE
         * REQUIRED method if users expect to call Model.destroy()
         *
         * @param  {[type]}   collectionName [description]
         * @param  {[type]}   options        [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        destroy: function (connectionName, collectionName, options, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                connectionString = me.getConnectionString(connection),
                __DESTROY__ = function () {
                    var whereData = [],
                        whereQuery = '',
                        params = [],
                        query = '';

                    _.each(options.where, function (param, column) {
                        if (collection.definition.hasOwnProperty(column)) {
                            whereData.push(column + ' = ?');
                            params.push(param);
                        }
                    });
                    whereQuery += whereData.join(' AND ');

                    if (whereQuery.length > 0) whereQuery = ' WHERE ' + whereQuery;

                    query = 'DELETE FROM ' + me.formatTableName(collection.tableName) + whereQuery + getFetchOnly(options.limit);
                    logQuery(query);
                    connection.conn.query(query, params, cb);
                },
                operationCallback = function (err, conn) {
                    if (err) {
                        return cb(err);
                    } else {
                        connection.conn = conn;
                        return __DESTROY__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        },


        /**
         *
         * TRUNCATE TABLE IMMEDIATE
         * No options!!
         *
         * @param  {[type]}   collectionName [description]
         * @param  {Function} cb             [description]
         * @return {[type]}                  [description]
         */
        truncate: function (connectionName, collectionName, cb) {
            var connection = me.connections[connectionName],
                collection = connection.collections[collectionName],
                connectionString = me.getConnectionString(connection),
                __TRUNCATE__ = function () {
                    var query = 'TRUNCATE TABLE ' + me.formatTableName(collection.tableName) + ' IMMEDIATE';
                    logQuery(query);
                    connection.conn.query(query, [], cb);
                },
                operationCallback = function (err, conn) {
                    if (err) {
                        return cb(err);
                    } else {
                        connection.conn = conn;
                        return __TRUNCATE__();
                    }
                };

            if (connection.pool) return connection.pool.open(connectionString, operationCallback);
            else return db2.open(connectionString, operationCallback);
        }



        /*
         **********************************************
         * Optional overrides
         **********************************************

         // Optional override of built-in batch create logic for increased efficiency
         // (since most databases include optimizations for pooled queries, at least intra-connection)
         // otherwise, Waterline core uses create()
         createEach: function (collectionName, arrayOfObjects, cb) { cb(); },

         // Optional override of built-in findOrCreate logic for increased efficiency
         // (since most databases include optimizations for pooled queries, at least intra-connection)
         // otherwise, uses find() and create()
         findOrCreate: function (collectionName, arrayOfAttributeNamesWeCareAbout, newAttributesObj, cb) { cb(); },
         */


        /*
         **********************************************
         * Custom methods
         **********************************************

         ////////////////////////////////////////////////////////////////////////////////////////////////////
         //
         // > NOTE:  There are a few gotchas here you should be aware of.
         //
         //    + The collectionName argument is always prepended as the first argument.
         //      This is so you can know which model is requesting the adapter.
         //
         //    + All adapter functions are asynchronous, even the completely custom ones,
         //      and they must always include a callback as the final argument.
         //      The first argument of callbacks is always an error object.
         //      For core CRUD methods, Waterline will add support for .done()/promise usage.
         //
         //    + The function signature for all CUSTOM adapter methods below must be:
         //      `function (collectionName, options, cb) { ... }`
         //
         ////////////////////////////////////////////////////////////////////////////////////////////////////


         // Custom methods defined here will be available on all models
         // which are hooked up to this adapter:
         //
         // e.g.:
         //
         foo: function (collectionName, options, cb) {
         return cb(null,"ok");
         },
         bar: function (collectionName, options, cb) {
         if (!options.jello) return cb("Failure!");
         else return cb();
         }

         // So if you have three models:
         // Tiger, Sparrow, and User
         // 2 of which (Tiger and Sparrow) implement this custom adapter,
         // then you'll be able to access:
         //
         // Tiger.foo(...)
         // Tiger.bar(...)
         // Sparrow.foo(...)
         // Sparrow.bar(...)


         // Example success usage:
         //
         // (notice how the first argument goes away:)
         Tiger.foo({}, function (err, result) {
         if (err) return console.error(err);
         else console.log(result);

         // outputs: ok
         });

         // Example error usage:
         //
         // (notice how the first argument goes away:)
         Sparrow.bar({test: 'yes'}, function (err, result){
         if (err) console.error(err);
         else console.log(result);

         // outputs: Failure!
         })




         */
    };


    // Expose adapter definition
    return adapter;
});

module.exports = function (adapterOptions) {
    return modul(adapterOptions);
};
