import { describe, expect, it } from 'vitest';
import { Binary, Decimal128, Double, Int32, Long, ObjectId, UUID, BSON, BSONRegExp } from 'mongodb';
import { docToShell, parseEditableDocument, parsePipeline, parseQueryDocument, parseImportText, FIDELITY_READ, bsonToWire } from '../../src/core/bsonCodec';
import { highlight, parseDocumentText, parseShell, ShellSyntaxError, validateDocumentText } from '../../src/shared/shell';

describe('shell parser', () => {
  it('parses the examples from the brief', () => {
    expect(parseQueryDocument('{ status: "active", age: { $gte: 18 } }')).toEqual({ status: 'active', age: { $gte: 18 } });
    expect(parseQueryDocument('{ createdAt: -1 }')).toEqual({ createdAt: -1 });
    expect(parseQueryDocument('{ name: 1, email: 1, _id: 0 }')).toEqual({ name: 1, email: 1, _id: 0 });
  });
  it('handles operators, regex, dotted keys, comments and trailing commas', () => {
    const q = parseQueryDocument(`{ // comment
      "address.city": 'Paris', profile.age: { $in: [1, 2.5,] }, name: /^ma/i, /* c */ $or: [{ a: 1 }, { b: null }],
    }`)!;
    expect(q['address.city']).toBe('Paris');
    expect(q['profile.age']).toEqual({ $in: [1, 2.5] });
    expect(q.name).toBeInstanceOf(BSONRegExp);
    expect(q.$or).toEqual([{ a: 1 }, { b: null }]);
  });
  it('accepts missing outer braces and blank text', () => {
    expect(parseQueryDocument('status: "active"')).toEqual({ status: 'active' });
    expect(parseQueryDocument('   ')).toBeUndefined();
    expect(parseQueryDocument('// only a comment')).toBeUndefined();
  });
  it('supports date arithmetic', () => {
    const q = parseQueryDocument('{ at: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }')!;
    const delta = Date.now() - q.at.$gte.getTime();
    expect(delta).toBeGreaterThan(6.9 * 864e5);
    expect(delta).toBeLessThan(7.1 * 864e5);
  });
  it('never evaluates code', () => {
    expect(() => parseShell('process.exit(1)')).toThrow(ShellSyntaxError);
    expect(() => parseShell('{ a: require("fs") }')).toThrow(/Unknown function/);
    expect(() => parseShell('(function(){ return 1 })()')).toThrow(ShellSyntaxError);
  });
  it('reports helpful errors with positions', () => {
    const cases: [string, RegExp][] = [
      ['{ status: active }', /Unknown value 'active'.*"active"/],
      ['{ a: 1', /not closed/],
      ['{ a 1 }', /Expected ':' after the field name "a"/],
      ['{ a: 1 b: 2 }', /Expected ',' or '}'/],
      ['{ a: "x }', /closing quote/],
      ['{ _id: ObjectId("abc") }', /24 hexadecimal/],
      ['{ d: ISODate("nope") }', /not a valid date/],
      ['[1,2]', /curly braces/],
    ];
    for (const [src, re] of cases) {
      const err = validateDocumentText(src);
      expect(err, src).not.toBeNull();
      expect(err!.message, src).toMatch(re);
    }
    const err = validateDocumentText('{\n  a: 1,\n  b: nope\n}')!;
    expect(err.line).toBe(3);
    expect(err.col).toBe(6);
  });
  it('rejects duplicate keys when converting', () => {
    expect(() => parseEditableDocument('{ a: 1, a: 2 }')).toThrow(/appears twice/);
  });
  it('is not vulnerable to __proto__ keys', () => {
    const d = parseEditableDocument('{ "__proto__": { polluted: 1 } }');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(d)).toEqual(['__proto__']);
  });
  it('highlights keys, operators and functions', () => {
    const src = '{ a: { $gt: ObjectId("x") } }';
    const by = (cls: string) => highlight(src).filter((h) => h.cls === cls).map((h) => src.slice(h.start, h.end));
    expect(by('key')).toEqual(['a']);
    expect(by('operator')).toEqual(['$gt']);
    expect(by('func')).toEqual(['ObjectId']);
  });
  it('parses pipelines', () => {
    expect(parsePipeline('[{ $match: { a: 1 } }, { $group: { _id: "$s", n: { $sum: 1 } } }]')).toHaveLength(2);
    expect(() => parsePipeline('{ a: 1 }')).toThrow(/square brackets/);
  });
  it('accepts Extended JSON input', () => {
    const d = parseEditableDocument('{"_id":{"$oid":"65a000000000000000000001"},"d":{"$date":"2024-01-01T00:00:00Z"},"l":{"$numberLong":"9007199254740993"}}');
    expect(d._id).toBeInstanceOf(ObjectId);
    expect(d.d).toBeInstanceOf(Date);
    expect(d.l.toString()).toBe('9007199254740993');
  });
  it('tolerates incomplete text in highlight without throwing', () => {
    for (const s of ['{', '{ "a', '/x', '{ a: new', '@@', '0x', '`']) expect(() => highlight(s)).not.toThrow();
    expect(parseDocumentText('{ }')?.entries).toEqual([]);
  });
});

describe('type fidelity', () => {
  const original = {
    _id: new ObjectId('65a000000000000000000001'),
    int: new Int32(5),
    double: new Double(5),
    frac: new Double(1.5),
    negZero: new Double(-0),
    huge: new Double(1e300),
    long: Long.fromString('9007199254740993'),
    dec: Decimal128.fromString('19.990'),
    date: new Date('2024-05-06T07:08:09.123Z'),
    bin: new Binary(Buffer.from('hello'), 0),
    binSub5: new Binary(Buffer.from('x'), 5),
    uuid: new UUID('00112233-4455-6677-8899-aabbccddeeff').toBinary(),
    re: new BSONRegExp('^a', 'ix'),
    str: 'quote " and \n newline é',
    nil: null,
    t: true,
    empty: {},
    emptyArr: [],
    arr: [new Int32(1), 'two', [new Double(3)], { four: new Int32(4) }],
    nested: { a: { b: { c: new Date(0) } } },
    'needs quotes': new Int32(1),
    '$odd.key': new Int32(1),
  };
  it('round-trips every type through editor text', () => {
    const bytes = BSON.serialize(original);
    const read = BSON.deserialize(bytes, FIDELITY_READ);
    const text = docToShell(read);
    const reparsed = parseEditableDocument(text);
    const bytes2 = BSON.serialize(reparsed);
    expect(Buffer.from(bytes2).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    expect(text).toContain('double: 5.0');
    expect(text).toContain('int: 5,');
    expect(text).toContain('NumberLong("9007199254740993")');
    expect(text).toContain('Decimal128("19.990")');
    expect(text).toContain('UUID("00112233-4455-6677-8899-aabbccddeeff")');
  });
  it('converts plain JS values', () => {
    expect(bsonToWire(5)).toEqual({ t: 'int', v: 5 });
    expect(bsonToWire(1.5)).toEqual({ t: 'dbl', v: 1.5 });
    expect(bsonToWire(10n)).toEqual({ t: 'long', v: '10' });
    expect(bsonToWire(new Map([['a', 1]]))).toEqual({ t: 'obj', e: [['a', { t: 'int', v: 1 }]] });
  });
});

describe('import parsing', () => {
  it('reads arrays, single documents and NDJSON', () => {
    expect(parseImportText('[{"a":1},{"a":2}]')).toHaveLength(2);
    expect(parseImportText('{"a":1}')).toHaveLength(1);
    expect(parseImportText('{"a":1}\n{"_id":{"$oid":"65a000000000000000000001"}}\n')).toHaveLength(2);
    expect(() => parseImportText('{"a":1}\n{bad}')).toThrow(/Line 2/);
    expect(parseImportText('[{"_id":{"$oid":"65a000000000000000000001"}}]')[0]._id).toBeInstanceOf(ObjectId);
  });
});
