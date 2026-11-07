// Fills a test MongoDB with realistic data. Only touches the databases named here.
import { Decimal128, Double, Int32, Long, MongoClient, ObjectId, UUID } from 'mongodb';

export const SEED_DBS = ['myapp', 'analytics'];

const first = ['Max', 'Alice', 'Bob', 'Chloe', 'David', 'Emma', 'Farid', 'Grace', 'Hugo', 'Iris', 'Jules', 'Karim', 'Lea', 'Marc', 'Nina'];
const last = ['Martin', 'Bernard', 'Dubois', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Garcia'];
const cities = ['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Lille', 'Nantes'];
const plans = ['free', 'pro', 'team', 'enterprise'];
const statuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

function pick(arr, i) { return arr[i % arr.length]; }

export async function seed(uri) {
  const client = await new MongoClient(uri).connect();
  for (const name of SEED_DBS) await client.db(name).dropDatabase();
  const db = client.db('myapp');

  const users = Array.from({ length: 1240 }, (_, i) => {
    const f = pick(first, i * 7 + 3);
    const l = pick(last, i * 3 + 1);
    const doc = {
      _id: new ObjectId((0x65a00000 + i).toString(16).padStart(8, '0') + '0000000000000000'),
      name: `${f} ${l}`,
      email: `${f}.${l}${i}@example.com`.toLowerCase(),
      age: new Int32(18 + ((i * 13) % 60)),
      active: i % 3 !== 0,
      plan: pick(plans, i),
      balance: new Double((i * 37) % 1000 + 0.5),
      createdAt: new Date(Date.UTC(2024, 0, 1) + i * 864e5 * 0.5),
      address: { city: pick(cities, i), zip: String(10000 + i * 11), geo: { lat: new Double(48.8 + (i % 10) / 10), lng: new Double(2.3) } },
      tags: i % 4 === 0 ? ['beta', 'newsletter'] : i % 4 === 1 ? ['newsletter'] : [],
    };
    if (i % 5 === 0) doc.nickname = null;
    if (i % 7 === 0) doc.phone = `+33 6 ${String(10000000 + i).slice(0, 8)}`;
    return doc;
  });
  await db.collection('users').insertMany(users);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ createdAt: -1 });
  await db.collection('users').createIndex({ plan: 1, active: 1 }, { sparse: true, name: 'plan_active' });

  const orders = Array.from({ length: 4820 }, (_, i) => ({
    number: new Long(100000 + i),
    userId: users[i % users.length]._id,
    status: pick(statuses, i * 3),
    total: Decimal128.fromString(`${(i * 17) % 500}.${String(i % 100).padStart(2, '0')}`),
    placedAt: new Date(Date.UTC(2024, 3, 1) + i * 36e5),
    items: Array.from({ length: (i % 3) + 1 }, (_, j) => ({ sku: `SKU-${(i + j) % 40}`, qty: new Int32(j + 1) })),
    trackingId: new UUID().toBinary(),
  }));
  await db.collection('orders').insertMany(orders);

  await db.collection('products').insertMany(Array.from({ length: 384 }, (_, i) => ({
    sku: `SKU-${i}`, title: `Product ${i}`, price: Decimal128.fromString(`${i % 90}.99`), stock: new Int32(i % 50),
    dims: { w: new Double(10 + i % 5), h: new Double(20) }, thumbnail: Buffer.from('fakeimage'),
  })));
  await db.collection('sessions').insertMany(Array.from({ length: 900 }, (_, i) => ({ token: `t${i}`, at: new Date() })));
  await db.collection('sessions').createIndex({ at: 1 }, { expireAfterSeconds: 86400 });
  await db.createCollection('active_users', { viewOn: 'users', pipeline: [{ $match: { active: true } }, { $project: { name: 1, email: 1, plan: 1 } }] });

  const analytics = client.db('analytics');
  await analytics.collection('events').insertMany(Array.from({ length: 200 }, (_, i) => ({ type: i % 2 ? 'click' : 'view', at: new Date() })));
  await client.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed(process.argv[2] ?? 'mongodb://127.0.0.1:27099');
  console.log('seeded');
}
