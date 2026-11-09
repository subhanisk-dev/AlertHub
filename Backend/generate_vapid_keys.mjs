// Create a VAPID key pair for local browser push and save it to ignored backend files.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const environmentPath = path.join(backendDirectory, '.env');
const privateKeyPath = path.join(backendDirectory, 'vapid_private.pem');
const environmentText = existsSync(environmentPath)
  ? readFileSync(environmentPath, 'utf8')
  : '';

// Refuse to rotate a configured key pair because saved browser subscriptions depend on it.
const configuredPublicKey = environmentText.match(/^VAPID_PUBLIC_KEY=([^\r\n]*)/im)?.[1].trim();
const configuredPrivateKey = environmentText.match(/^VAPID_PRIVATE_KEY=([^\r\n]*)/im)?.[1].trim();
if (configuredPublicKey || (configuredPrivateKey && configuredPrivateKey !== 'vapid_private.pem')) {
  throw new Error('VAPID keys already exist in Backend/.env; refusing to replace them.');
}
if (existsSync(privateKeyPath)) {
  throw new Error('Backend/vapid_private.pem already exists; refusing to overwrite it.');
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyData = privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(keyData.x, 'base64url'),
  Buffer.from(keyData.y, 'base64url'),
]).toString('base64url');
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });

// Keep the signing key private and only publish the public key to the browser.
writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });

const settings = {
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: 'vapid_private.pem',
  VAPID_SUBJECT: 'mailto:admin@example.com',
};
let updatedEnvironment = environmentText.trimEnd();
for (const [name, value] of Object.entries(settings)) {
  const settingLine = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');
  updatedEnvironment = matcher.test(updatedEnvironment)
    ? updatedEnvironment.replace(matcher, settingLine)
    : `${updatedEnvironment}${updatedEnvironment ? '\n' : ''}${settingLine}`;
}
writeFileSync(environmentPath, `${updatedEnvironment}\n`);

process.stdout.write('VAPID key pair generated in Backend/.env and Backend/vapid_private.pem.\n');
