import { describe, expect, it } from 'vitest';
import * as cs from '../../src/core/connectionString';
import { isLocalEndpoint, resolveModel, validateGenerated } from '../../src/core/ai';

describe('connection strings', () => {
  it('validates', () => {
    expect(cs.validateUri('mongodb://localhost')).toBeNull();
    expect(cs.validateUri('mongodb+srv://u:p@x.mongodb.net/db')).toBeNull();
    expect(cs.validateUri('http://x')).toMatch(/starts with/);
    expect(cs.validateUri('')).toMatch(/Enter/);
  });
  it('removes credentials from any text', () => {
    const out = cs.redact('failed to connect mongodb+srv://bob:s3cret@host.net/db?password=abc&x=1');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('abc');
    expect(out).toContain('host.net');
  });
  it('splits and restores passwords, including special characters', () => {
    const uri = 'mongodb://bob:p%40ss%2Fw0rd@localhost:27017/app?tls=true';
    const { uri: bare, password } = cs.splitPassword(uri);
    expect(password).toBe('p@ss/w0rd');
    expect(bare).not.toContain('w0rd');
    expect(bare).toContain('bob@');
    const back = cs.withPassword(bare, password);
    expect(cs.splitPassword(back).password).toBe('p@ss/w0rd');
    expect(cs.getUsername(uri)).toBe('bob');
    expect(cs.defaultDatabase(uri)).toBe('app');
  });
  it('labels hosts without credentials', () => {
    expect(cs.hostLabel('mongodb://u:p@a:1,b:2/x')).toBe('a:1, b:2');
  });
  it('guesses the environment', () => {
    expect(cs.guessEnvironment('Production', 'mongodb://h')).toBe('production');
    expect(cs.guessEnvironment('x', 'mongodb+srv://u:p@app-prod.mongodb.net')).toBe('production');
    expect(cs.guessEnvironment('Staging', 'mongodb://h')).toBe('staging');
    expect(cs.guessEnvironment('x', 'mongodb://localhost:27017')).toBe('local');
    expect(cs.guessEnvironment('reproduce', 'mongodb://h')).toBe('none');
    // A username must not change the classification.
    expect(cs.guessEnvironment('x', 'mongodb://prod:pw@h')).toBe('none');
  });
  it('finds URIs in .env files', () => {
    const found = cs.findUrisInEnv([
      '# MONGO_OLD=mongodb://old',
      'export MONGO_URL="mongodb://a:b@h:1/db" # primary',
      "SECOND='mongodb+srv://x.y.z/db'",
      'THIRD=mongodb://h3 # note',
      'OTHER=postgres://x',
      'BROKEN=mongodb://',
    ].join('\n'));
    expect(found.map((f) => f.key)).toEqual(['MONGO_URL', 'SECOND', 'THIRD']);
    expect(found[0].uri).toBe('mongodb://a:b@h:1/db');
    expect(found[2].uri).toBe('mongodb://h3');
  });
  it('builds SSH arguments and tunnel URIs', () => {
    const a = cs.sshArgs({ host: 'bastion', user: 'me', port: 2222, identityFile: '/k' }, 5000, { host: 'db', port: 27017 });
    expect(a).toContain('127.0.0.1:5000:db:27017');
    expect(a).toContain('BatchMode=yes');
    expect(a.at(-1)).toBe('me@bastion');
    const u = cs.rewriteForTunnel('mongodb://u:p@db:27017/app?replicaSet=rs', 5000);
    expect(u).toContain('127.0.0.1:5000');
    expect(u).toContain('directConnection=true');
    expect(u).not.toContain('replicaSet');
    expect(() => cs.firstHost('mongodb+srv://x.y.z')).toThrow(/SSH/);
    expect(cs.firstHost('mongodb://db1:1234,db2')).toEqual({ host: 'db1', port: 1234 });
  });
});

describe('AI helpers', () => {
  const models = [
    { name: 'llama3.2:latest', size: 2e9, capabilities: ['completion'] },
    { name: 'qwen3.5:4b', size: 3e9, capabilities: ['completion'] },
    { name: 'qwen3.5:latest', size: 6e9, capabilities: ['completion'] },
    { name: 'qwen3-vl:8b', size: 7e9, capabilities: ['completion', 'vision'] },
    { name: 'nimble:latest', size: 9e9, capabilities: ['decision'], details: { family: 'qwen35' } },
  ];
  it('resolves model names loosely, then falls back to Qwen', () => {
    expect(resolveModel('llama3.2', models)).toEqual({ name: 'llama3.2:latest', exact: true });
    expect(resolveModel('qwen-3.5-4b', models)).toEqual({ name: 'qwen3.5:4b', exact: true });
    expect(resolveModel('qwen-3.6-35b-a-3b', [{ name: 'qwen3.6:35b-a3b' }, ...models])).toEqual({ name: 'qwen3.6:35b-a3b', exact: true });
    expect(resolveModel('qwen-3.6-35b-a-3b', [{ name: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:latest' }])?.exact).toBe(true);
    // A missing model falls back to the smallest Qwen text model, not the largest.
    expect(resolveModel('qwen3.6:35b-a3b', models)).toEqual({ name: 'qwen3.5:4b', exact: false });
    expect(resolveModel('x', [])).toBeNull();
  });
  it('validates generated queries', () => {
    expect(validateGenerated({ filter: '{ a: 1 }', sort: '', projection: '{}', limit: 0, explanation: 'x' })).toMatchObject({ filter: '{ a: 1 }', project: '', limit: '' });
    expect(validateGenerated({ filter: '{}', sort: '{ a: -1 }', projection: '', limit: 5 })).toMatchObject({ filter: '', sort: '{ a: -1 }', limit: '5' });
    expect(() => validateGenerated({ filter: '{ $where: "1" }' })).toThrow(/JavaScript/);
    expect(() => validateGenerated({ filter: '{ a: nope }' })).toThrow(/not valid/);
  });
  it('recognizes local endpoints', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalEndpoint('https://ollama.example.com')).toBe(false);
  });
});
