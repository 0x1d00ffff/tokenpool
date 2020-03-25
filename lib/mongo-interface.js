
var mongoClient = require('mongodb').MongoClient
var url = 'mongodb://localhost:27017/tokenpool'
var dbo
module.exports = {

  async init (dbName) {
    if (dbName == null) {
      dbName = 'pooldb'
    }

    await new Promise(function (resolve, reject) {
      mongoClient.connect(url, function (err, db) {
        if (err) throw err
        dbo = db.db(dbName)

        resolve(dbo)
      })
    })
  },

  async insertOne (collectionName, obj) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).insertOne(obj, function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  async updateOne (collectionName, query, newvalues) {
    var setvalues = { $set: newvalues }

    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).updateOne(query, setvalues, function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  async upsertOne (collectionName, query, newvalues) {
    var setvalues = { $set: newvalues }

    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).updateOne(query, setvalues, { upsert: true }, function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  async deleteOne (collectionName, obj) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).deleteOne(obj, function (err, res) {
        if (err) reject(err)
        //  console.log("1 inserted ",collectionName);
        resolve(res)
      })
    })
  },

  async deleteMany (collectionName, query) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).deleteMany(query, function (err, res) {
        if (err) reject(err)
        //  console.log("1 inserted ",collectionName);
        resolve(res)
      })
    })
  },

  async dropCollection (collectionName) {
    return new Promise(function (resolve, reject) {
      dbo.dropCollection(collectionName, function (err, res) {
        if (err) reject(err)
        //  console.log("1 inserted ",collectionName);
        resolve(res)
      })
    })
  },

  async findOne (collectionName, query) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).findOne(query, function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  async findAll (collectionName, query, outputFields) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).find(query, outputFields).toArray(function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  async findAllSorted (collectionName, query, sortBy) {
    return new Promise(function (resolve, reject) {
      dbo.collection(collectionName).find(query).sort(sortBy).toArray(function (err, res) {
        if (err) reject(err)
        resolve(res)
      })
    })
  },

  getMongoClient () {
    return mongoClient
  }

}
