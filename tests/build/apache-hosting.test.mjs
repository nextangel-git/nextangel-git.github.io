// Policy simulation for the small rewrite subset used by this release.
// This does not replace an Apache config test / live HTTP smoke test on NIC.RU.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'public/.htaccess'), 'utf8');
const built = fs.readFileSync(path.join(root, 'dist/.htaccess'), 'utf8');
const rules = [];
let conditions = [];
for (const line of source.split(/\r?\n/).map(line => line.trim())) {
  if (line.startsWith('RewriteCond ')) {
    const match = line.match(/^RewriteCond\s+(\S+)\s+(\S+)(?:\s+\[([^\]]+)\])?$/);
    assert.ok(match, `unsupported condition: ${line}`);
    conditions.push({ input: match[1], pattern: match[2], flags: (match[3] || '').split(',') });
  } else if (line.startsWith('RewriteRule ')) {
    const match = line.match(/^RewriteRule\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]$/);
    assert.ok(match, `unsupported rule: ${line}`);
    const flags = match[3].split(',');
    assert.ok(flags.every(flag => ['F', 'END', 'NE', 'QSD', 'R=301'].includes(flag)), `unsupported flags: ${line}`);
    rules.push({ pattern: match[1], target: match[2], flags, conditions });
    conditions = [];
  }
}
assert.equal(conditions.length, 0, 'dangling rewrite condition');

function request(uri, options = {}) {
  const [pathname] = uri.split('?');
  const variables = {
    HTTP_HOST: options.host || 'jks.ooo',
    HTTPS: options.https ?? 'off',
    'ENV:HTTPS': options.envHttps ?? 'on',
    REQUEST_URI: pathname,
    REQUEST_FILENAME: '/site' + pathname,
    DOCUMENT_ROOT: '/site',
    THE_REQUEST: `GET ${uri} HTTP/1.1`,
  };
  function isFile(filename) {
    const relative = path.posix.normalize(filename).replace(/^\/site\//, '');
    return options.extraFiles?.includes(relative) || (fs.existsSync(path.join(root, 'dist', relative)) && fs.statSync(path.join(root, 'dist', relative)).isFile());
  }
  for (const rule of rules) {
    const match = new RegExp(rule.pattern).exec(pathname.replace(/^\//, ''));
    if (!match) continue;
    const expand = text => text.replace(/%\{([^}]+)\}/g, (_, name) => variables[name] ?? '').replace(/\$(\d)/g, (_, index) => match[index] ?? '');
    if (!rule.conditions.every(condition => {
      const input = expand(condition.input);
      if (condition.pattern === '-f') return isFile(input);
      const negate = condition.pattern.startsWith('!');
      const regex = new RegExp(negate ? condition.pattern.slice(1) : condition.pattern, condition.flags.includes('NC') ? 'i' : '');
      return regex.test(input) !== negate;
    })) continue;
    if (rule.flags.includes('F')) return { status: 403 };
    if (rule.flags.includes('R=301')) {
      const query = !rule.flags.includes('QSD') && uri.includes('?') ? '?' + uri.split('?').slice(1).join('?') : '';
      return { status: 301, target: expand(rule.target) + query };
    }
    return { status: 200, target: rule.target === '-' ? pathname : '/' + expand(rule.target) };
  }
  if (pathname === '/') return { status: 200, target: '/index.html' };
  return { status: 404, target: '/404.html' };
}

test('Apache policy is shipped unchanged with UTF-8, security headers and local 404', () => {
  assert.equal(built, source);
  assert.match(source, /^Options -Indexes -MultiViews$/m);
  assert.match(source, /^DirectoryIndex index\.html$/m);
  assert.match(source, /^DirectorySlash Off$/m);
  assert.match(source, /^RewriteOptions AllowNoSlash$/m);
  assert.match(source, /^AddDefaultCharset UTF-8$/m);
  assert.match(source, /^ErrorDocument 404 \/404\.html$/m);
  assert.match(source, /Header always set X-Content-Type-Options "nosniff"/);
  assert.match(source, /Header always set Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.doesNotMatch(source, /^\s*(?:php_value|php_flag|AddHandler|SetHandler|FallbackResource)\b/m);
});

test('Astro pages use their generated indexes and preserve asset paths', () => {
  for (const route of ['about', 'admin', 'house', 'request', 'disclosure', 'useful/pochemu-rastet-tarif']) {
    assert.deepEqual(request('/' + route), { status: 200, target: '/' + route + '/index.html' });
    assert.deepEqual(request('/' + route + '/'), { status: 301, target: '/' + route });
  }
  assert.deepEqual(request('/logo.svg'), { status: 200, target: '/logo.svg' });
  assert.deepEqual(request('/index.html'), { status: 301, target: '/' });
  assert.deepEqual(request('/nonexistent-page'), { status: 404, target: '/404.html' });
});

test('HTML shells revalidate while PHP and hashed assets keep their own cache policies', () => {
  const scopes = [...source.matchAll(/<FilesMatch\s+"([^"]+)">([\s\S]*?)<\/FilesMatch>/g)]
    .filter(([, , directives]) => /Header\s+.*Cache-Control/i.test(directives));
  assert.equal(scopes.length, 1, 'cache policy must have one explicit file scope');
  const [, pattern, directives] = scopes[0];
  const matches = filename => new RegExp(pattern).test(path.posix.basename(filename));
  const header = directives.match(/Header\s+always\s+set\s+Cache-Control\s+"([^"]+)"/);
  assert.ok(header, 'cache header must cover normal and error HTML responses');
  const tokens = new Set(header[1].split(',').map(value => value.trim().toLowerCase()));
  for (const token of ['no-cache', 'max-age=0', 'must-revalidate']) assert.ok(tokens.has(token), token);
  assert.match(directives, /Header\s+onsuccess\s+unset\s+Cache-Control/, 'avoid duplicate normal-response headers');
  for (const route of ['/', '/admin', '/about', '/404.html']) assert.ok(matches(request(route).target), route);
  for (const filename of ['/api/admin.php', '/_astro/admin.Abc123.js', '/_astro/style.Def456.css', '/documents/report.pdf']) assert.equal(matches(filename), false, filename);
  const outsideScope = source.replace(scopes[0][0], '');
  assert.doesNotMatch(outsideScope, /^\s*Header\s+.*Cache-Control/im, 'no global override of API or asset caching');
});

test('TLS and www canonicalization do not loop behind NIC TLS termination', () => {
  assert.equal(request('/about', { https: 'off', envHttps: 'on' }).status, 200);
  assert.equal(request('/about', { https: 'on', envHttps: '' }).status, 200);
  assert.deepEqual(request('/about?x=1', { https: 'off', envHttps: '' }), { status: 301, target: 'https://jks.ooo/about?x=1' });
  assert.deepEqual(request('/about', { host: 'www.jks.ooo' }), { status: 301, target: 'https://jks.ooo/about' });
  assert.equal(request('/about', { host: 'malicious.example', https: 'off', envHttps: '' }).status, 200);
});

test('hidden files are denied while certificate challenges bypass redirects', () => {
  for (const uri of ['/.env', '/.git/config', '/admin/.secret', '/.well-known/.env', '/.jks-deploy-target.json', '/.jks-deploy-manifest.json', '/.jks-upload-uuid-index.html']) assert.equal(request(uri).status, 403);
  assert.deepEqual(request('/.well-known/acme-challenge/token', { https: 'off', envHttps: '', host: 'www.jks.ooo' }), { status: 200, target: '/.well-known/acme-challenge/token' });
});

test('only known legacy counterparts redirect; removed news and documents stay 404', () => {
  const redirects = {
    '/about/licence.php': '/disclosure', '/about/ustav.php': '/disclosure',
    '/about/confpolicy.php': '/privacy', '/contacts/': '/#contacts',
    '/documents/': '/disclosure', '/documents/general-information/': '/disclosure',
    '/documents/tarify-na-kommunalnye-resursy/': 'https://jks.ooo/disclosure',
    '/useful-info/tarify/': 'https://jks.ooo/disclosure',
    '/tariffs': 'https://jks.ooo/disclosure', '/tariffs/': 'https://jks.ooo/disclosure', '/tariffs/index.html': 'https://jks.ooo/disclosure', '/tariffs?year=2025': 'https://jks.ooo/disclosure',
    '/useful-info/spisok-domov-v-upravlenii-uk-zhilkomservis.php': '/#houses',
  };
  for (const [uri, target] of Object.entries(redirects)) assert.deepEqual(request(uri), { status: 301, target });
  for (const uri of ['/news/123.html', '/upload/old.pdf', '/komfort/old', '/photogallery/', '/auth/', '/useful-info/obsheeim.php']) assert.equal(request(uri).status, 404);
  assert.deepEqual(request('/news/123.html', { extraFiles: ['news/123/index.html'] }), { status: 301, target: '/news/123' });
});
