// Names used for autocomplete in the query bar and playgrounds.
export const QUERY_OPERATORS: [string, string][] = [
  ['$eq', 'Equal to'], ['$ne', 'Not equal to'], ['$gt', 'Greater than'], ['$gte', 'Greater than or equal'],
  ['$lt', 'Less than'], ['$lte', 'Less than or equal'], ['$in', 'In a list'], ['$nin', 'Not in a list'],
  ['$and', 'All conditions match'], ['$or', 'Any condition matches'], ['$nor', 'No condition matches'], ['$not', 'Negates a condition'],
  ['$exists', 'Field is present'], ['$type', 'Field has a BSON type'], ['$regex', 'Matches a regular expression'], ['$options', 'Regex options'],
  ['$expr', 'Use aggregation expressions'], ['$text', 'Text search'], ['$search', 'Text search term'], ['$mod', 'Modulo'],
  ['$all', 'Array has all values'], ['$elemMatch', 'An array element matches'], ['$size', 'Array has this length'],
  ['$geoWithin', 'Within a shape'], ['$near', 'Near a point'], ['$jsonSchema', 'Matches a JSON schema'],
  ['$bitsAllSet', 'All bit positions set'], ['$bitsAnySet', 'Any bit position set'], ['$comment', 'Add a comment'],
];

export const VALUE_HELPERS: [string, string][] = [
  ['ObjectId("")', 'ObjectId'], ['ISODate("")', 'Date'], ['new Date()', 'Current date'], ['NumberLong("")', 'Int64'],
  ['Decimal128("")', 'Decimal128'], ['UUID("")', 'UUID'], ['true', 'Boolean'], ['false', 'Boolean'], ['null', 'Null'],
];

export const AGG_STAGES: [string, string, string][] = [
  ['$match', 'Filter documents', '{ status: "active" }'],
  ['$group', 'Group and accumulate', '{ _id: "$status", count: { $sum: 1 } }'],
  ['$project', 'Choose or compute fields', '{ name: 1, total: { $add: ["$a", "$b"] } }'],
  ['$addFields', 'Add computed fields', '{ fullName: { $concat: ["$first", " ", "$last"] } }'],
  ['$set', 'Add or replace fields', '{ active: true }'],
  ['$unset', 'Remove fields', '"internal"'],
  ['$sort', 'Order documents', '{ createdAt: -1 }'],
  ['$limit', 'Keep the first N', '10'],
  ['$skip', 'Skip the first N', '10'],
  ['$unwind', 'One document per array element', '"$items"'],
  ['$lookup', 'Join another collection', '{ from: "other", localField: "otherId", foreignField: "_id", as: "other" }'],
  ['$count', 'Count documents', '"total"'],
  ['$sortByCount', 'Group and count, descending', '"$status"'],
  ['$sample', 'Random documents', '{ size: 10 }'],
  ['$replaceRoot', 'Promote a nested document', '{ newRoot: "$nested" }'],
  ['$facet', 'Several pipelines at once', '{ byStatus: [{ $sortByCount: "$status" }] }'],
  ['$bucket', 'Group by ranges', '{ groupBy: "$age", boundaries: [0, 18, 65, 120], default: "other" }'],
  ['$densify', 'Fill gaps in a sequence', '{ field: "at", range: { step: 1, unit: "day", bounds: "full" } }'],
  ['$unionWith', 'Combine with another collection', '{ coll: "other" }'],
  ['$out', 'Write results to a collection (replaces it)', '"output"'],
  ['$merge', 'Merge results into a collection', '{ into: "output" }'],
];

export const COLLECTION_METHODS: [string, string][] = [
  ['find', 'find(filter, projection)'], ['findOne', 'findOne(filter, projection)'], ['aggregate', 'aggregate(pipeline)'],
  ['countDocuments', 'countDocuments(filter)'], ['estimatedDocumentCount', 'estimatedDocumentCount()'], ['distinct', 'distinct(field, filter)'],
  ['insertOne', 'insertOne(document)'], ['insertMany', 'insertMany(documents)'], ['updateOne', 'updateOne(filter, update)'],
  ['updateMany', 'updateMany(filter, update)'], ['replaceOne', 'replaceOne(filter, document)'], ['deleteOne', 'deleteOne(filter)'],
  ['deleteMany', 'deleteMany(filter)'], ['findOneAndUpdate', 'findOneAndUpdate(filter, update)'], ['findOneAndDelete', 'findOneAndDelete(filter)'],
  ['findOneAndReplace', 'findOneAndReplace(filter, document)'], ['bulkWrite', 'bulkWrite(operations)'], ['createIndex', 'createIndex(keys, options)'],
  ['getIndexes', 'getIndexes()'], ['dropIndex', 'dropIndex(name)'], ['stats', 'stats()'], ['drop', 'drop()'],
  ['explain', 'explain(verbosity).find(filter)'],
];

export const DB_METHODS: [string, string][] = [
  ['getCollection', 'getCollection(name)'], ['getCollectionNames', 'getCollectionNames()'], ['getSiblingDB', 'getSiblingDB(name)'],
  ['runCommand', 'runCommand(command)'], ['adminCommand', 'adminCommand(command)'], ['stats', 'stats()'], ['version', 'version()'],
  ['createCollection', 'createCollection(name, options)'], ['createView', 'createView(name, source, pipeline)'], ['dropDatabase', 'dropDatabase()'],
  ['getName', 'getName()'], ['aggregate', 'aggregate(pipeline)'],
];

export const CURSOR_METHODS: [string, string][] = [
  ['sort', 'sort(spec)'], ['limit', 'limit(n)'], ['skip', 'skip(n)'], ['project', 'project(spec)'], ['toArray', 'toArray()'],
  ['hasNext', 'hasNext()'], ['next', 'next()'], ['forEach', 'forEach(fn)'], ['map', 'map(fn)'], ['count', 'count()'], ['itcount', 'itcount()'], ['explain', 'explain()'],
];

export const UPDATE_OPERATORS: [string, string][] = [
  ['$set', 'Set field values'], ['$unset', 'Remove fields'], ['$inc', 'Increment'], ['$mul', 'Multiply'], ['$rename', 'Rename fields'],
  ['$min', 'Keep the lower value'], ['$max', 'Keep the higher value'], ['$currentDate', 'Set to the current date'],
  ['$push', 'Add to an array'], ['$pull', 'Remove from an array'], ['$addToSet', 'Add to an array if absent'], ['$pop', 'Remove first or last'],
];
