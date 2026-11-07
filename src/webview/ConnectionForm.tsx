import { useEffect, useState } from 'preact/hooks';
import { client } from './rpc';
import { Button, Icon } from './ui';
import type { ConnectionFormApi, ConnectionFormData } from '../shared/protocol';

const api = client<ConnectionFormApi>();

const ENVS: [string, string][] = [['none', 'None'], ['local', 'Local'], ['development', 'Dev'], ['staging', 'Staging'], ['production', 'Production']];
const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

export function ConnectionForm() {
  const [f, setF] = useState<ConnectionFormData | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [envTouched, setEnvTouched] = useState(false);

  useEffect(() => {
    void api('load').then((d) => {
      setF(d);
      setEnvTouched(!!d.id);
      setAdvanced(d.sshEnabled);
    });
  }, []);

  if (!f) return <div class="center-message"><Icon name="loading" spin /></div>;
  const set = (p: Partial<ConnectionFormData>) => { setF((v) => ({ ...v!, ...p })); setStatus(null); };

  const guessEnv = (name: string, uri: string) => {
    if (envTouched) return;
    void api('guessEnvironment', { name, uri }).then((environment) => setF((v) => ({ ...v!, environment })));
  };

  const hasAuthInUri = /^mongodb(\+srv)?:\/\/[^/@]+@/.test(f.uri);
  const passwordInUri = /^mongodb(\+srv)?:\/\/[^/:@]+:[^/@]+@/.test(f.uri);

  const test = async () => {
    setBusy('test');
    setStatus(null);
    try {
      setStatus(await api('test', f));
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async (connect: boolean) => {
    setBusy('save');
    try {
      const r = await api('save', { form: f, connect });
      if (!r.ok) setStatus({ ok: false, message: r.message ?? 'Could not save.' });
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form class="conn-form" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
      <h1>{f.id ? 'Edit Connection' : 'New Connection'}</h1>

      <label class="form-field">
        <span>Connection string</span>
        <textarea
          class="input mono"
          rows={2}
          spellcheck={false}
          autocomplete="off"
          placeholder="mongodb+srv://user@cluster.mongodb.net/mydb"
          value={f.uri}
          onInput={(e) => { const uri = e.currentTarget.value; set({ uri }); guessEnv(f.name, uri); }}
        />
        <div class="field-actions">
          <span class="hint">Atlas, self-hosted or localhost. TLS and auth options go in the string, for example <code>?tls=true&amp;authSource=admin</code>.</span>
          <Button onClick={() => void api('importEnv').then((r) => {
            if (r) { set({ uri: r.uri, password: r.password || f.password, name: f.name || r.name }); guessEnv(f.name || r.name, r.uri); }
          })}><Icon name="file-symlink-file" /> Import from .env</Button>
        </div>
      </label>

      {hasAuthInUri && !passwordInUri && (
        <label class="form-field">
          <span>Password</span>
          <input
            class="input"
            type="password"
            autocomplete="off"
            placeholder={f.hasSavedPassword ? 'Saved. Leave empty to keep it.' : 'Password'}
            value={f.password}
            onInput={(e) => set({ password: e.currentTarget.value })}
          />
        </label>
      )}
      {passwordInUri && <div class="hint"><Icon name="lock" /> The password in this string will be stored in VS Code SecretStorage, never in plain text.</div>}

      <label class="form-field">
        <span>Name</span>
        <input class="input" placeholder="Production" value={f.name} onInput={(e) => { const name = e.currentTarget.value; set({ name }); guessEnv(name, f.uri); }} />
      </label>

      <div class="form-field">
        <span id="env-label">Environment</span>
        <div class="segmented text" role="radiogroup" aria-labelledby="env-label">
          {ENVS.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={f.environment === v} class={`${f.environment === v ? 'active' : ''}${v === 'production' ? ' env-prod-option' : ''}`} onClick={() => { setEnvTouched(true); set({ environment: v }); }}>{label}</button>
          ))}
        </div>
        {f.environment === 'production' && <div class="hint warn-text"><Icon name="warning" /> Production connections are marked in red, and every write asks for confirmation.</div>}
      </div>

      <div class="form-field">
        <span id="color-label">Color</span>
        <div class="swatches" role="radiogroup" aria-labelledby="color-label">
          {COLORS.map((c) => (
            <button key={c || 'none'} type="button" role="radio" aria-checked={f.color === c} aria-label={c || 'Default color'} title={c || 'Default'} class={`swatch swatch-${c || 'none'}${f.color === c ? ' active' : ''}`} onClick={() => set({ color: c })} />
          ))}
        </div>
      </div>

      <label class="check-row">
        <input type="checkbox" checked={f.readOnly} onChange={(e) => set({ readOnly: e.currentTarget.checked })} />
        <span>Read-only <span class="hint">Block writes from the viewer, document editor and playgrounds.</span></span>
      </label>

      <button type="button" class="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        <Icon name={advanced ? 'chevron-down' : 'chevron-right'} /> SSH tunnel
      </button>
      {advanced && (
        <div class="advanced">
          <label class="check-row">
            <input type="checkbox" checked={f.sshEnabled} onChange={(e) => set({ sshEnabled: e.currentTarget.checked })} />
            <span>Connect through SSH <span class="hint">Uses your ssh command, config and agent. Password prompts aren't supported.</span></span>
          </label>
          {f.sshEnabled && (
            <>
              <div class="form-row">
                <label class="form-field grow"><span>SSH host</span><input class="input" placeholder="bastion.example.com" value={f.sshHost} onInput={(e) => set({ sshHost: e.currentTarget.value })} /></label>
                <label class="form-field"><span>Port</span><input class="input" inputMode="numeric" placeholder="22" value={f.sshPort} onInput={(e) => set({ sshPort: e.currentTarget.value })} /></label>
              </div>
              <label class="form-field"><span>SSH user</span><input class="input" placeholder="Default from your SSH config" value={f.sshUser} onInput={(e) => set({ sshUser: e.currentTarget.value })} /></label>
              <label class="form-field"><span>Identity file</span>
                <div class="input-with-button">
                  <input class="input grow" placeholder="Default from your SSH config" value={f.sshIdentityFile} onInput={(e) => set({ sshIdentityFile: e.currentTarget.value })} />
                  <Button onClick={() => void api('browseFile').then((p) => { if (p) set({ sshIdentityFile: p }); })}>Browse…</Button>
                </div>
              </label>
            </>
          )}
        </div>
      )}

      {status && (
        <div class={`banner ${status.ok ? 'success' : 'error'}`} role="status">
          <Icon name={status.ok ? 'check' : 'error'} /> <span>{status.message}</span>
        </div>
      )}

      <div class="dialog-buttons">
        <Button onClick={() => void api('cancel')}>Cancel</Button>
        <Button onClick={() => void test()} disabled={!!busy || !f.uri.trim()}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</Button>
        <Button onClick={() => void save(false)} disabled={!!busy}>Save</Button>
        <Button primary type="submit" disabled={!!busy}>Save and Connect</Button>
      </div>
    </form>
  );
}
