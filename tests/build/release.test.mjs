import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = path.join(root, 'dist');
const read = (name) => fs.readFileSync(path.join(dist, name), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const files = walk(dist);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const robots = read('robots.txt');
const sitemapUrl = new URL(robots.match(/^Sitemap:\s*(\S+)/m)?.[1]);
const origin = sitemapUrl.origin;
const publicPhpFiles = ['admin.php', 'admin-core.php', 'admin-schema.php', 'captcha-core.php', 'request.php', 'request-core.php', 'request-store.php'];

test('robots and sitemap use one configured origin and omit non-indexable routes', () => {
  assert.equal(sitemapUrl.pathname, '/sitemap-index.xml');
  const sitemapFiles = files.filter((file) => /sitemap[^/\\]*\.xml$/.test(file));
  assert.ok(sitemapFiles.length >= 2);
  for (const file of sitemapFiles) {
    for (const [, raw] of fs.readFileSync(file, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)) {
      const url = new URL(raw);
      assert.equal(url.origin, origin);
      assert.ok(!['/admin', '/404', '/house'].includes(url.pathname.replace(/\/$/, '')), raw);
    }
  }
});

test('HTML has consistent SEO, Russian language and a labelled main landmark', () => {
  assert.ok(htmlFiles.length >= 10);
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /<html[^>]*lang="ru"/, file);
    assert.match(html, /<title>[^<]+<\/title>/, file);
    assert.match(html, /<main[^>]*id="main-content"/, file);
    const noindex = /<meta[^>]*name="robots"[^>]*content="noindex, follow"/.test(html);
    const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/);
    assert.ok(noindex || canonical, file);
    if (canonical) assert.equal(new URL(canonical[1]).origin, origin, file);
    const schema = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(schema, file);
    const org = JSON.parse(schema[1]);
    assert.equal(new URL(org.url).origin, origin);
    assert.equal(new URL(org.logo).origin, origin);
  }
});

test('admin, generic house and 404 are noindex', () => {
  for (const route of ['admin', 'house', '404']) {
    const file = [`${route}/index.html`, `${route}.html`].find((name) => fs.existsSync(path.join(dist, name)));
    assert.ok(file, route);
    assert.match(read(file), /<meta[^>]*name="robots"[^>]*content="noindex, follow"/, route);
  }
});

test('rendered local links and assets resolve within the release artifact', () => {
  const missing = [];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    const relative = path.relative(dist, file).replaceAll('\\', '/').replace(/index\.html$/, '');
    const pageUrl = new URL(relative, `${origin}/`);
    for (const [, raw] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (!raw || raw.startsWith('#') || /^(?:mailto|tel|data|javascript):/i.test(raw)) continue;
      const url = new URL(raw.replaceAll('&amp;', '&'), pageUrl);
      if (url.origin !== origin) continue;
      const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const clean = pathname.replace(/\/$/, '');
      const options = [pathname, `${pathname}.html`, clean ? `${clean}/index.html` : 'index.html'];
      if (!options.some((name) => {
        const target = path.resolve(dist, name);
        return target.startsWith(`${dist}${path.sep}`) && fs.existsSync(target) && fs.statSync(target).isFile();
      })) missing.push(`${path.relative(dist, file)} -> ${raw}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('private configuration and source data are absent from public output', () => {
  for (const file of files) {
    const relative = path.relative(dist, file).replaceAll('\\', '/');
    assert.ok(!/(^|\/)(\.env(?:\..*)?|\.secret|users\.json|server\.mjs|package-lock\.json)$/.test(relative), relative);
    assert.ok(!relative.startsWith('.git/'), relative);
    assert.ok(!/(^|\/)(?:config\.(?:php|json)|captcha\.php|credentials\.json|secrets\.json)$|\.(?:sql|sqlite3?|db)$/i.test(relative), relative);
    assert.ok(!relative.split('/').includes('.jks-admin'), relative);
    if (/\.(?:php[0-9]*|phtml|phar|inc)(?:\.|$)/i.test(relative)) assert.ok(publicPhpFiles.some(name => relative === 'api/' + name), relative);
    if (/\.(?:html|js|mjs|json|php)$/.test(relative)) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/, `GitHub credential in ${relative}`);
    }
  }
});

test('public PHP endpoint is copied unchanged and runtime configuration remains outside the artifact', () => {
  for (const name of publicPhpFiles) {
    assert.deepEqual(fs.readFileSync(path.join(dist, 'api', name)), fs.readFileSync(path.join(root, 'public', 'api', name)));
  }
  assert.equal(fs.existsSync(path.join(dist, '.jks-admin')), false);
  assert.equal(fs.existsSync(path.join(dist, 'config.php')), false);
  assert.equal(fs.existsSync(path.join(dist, 'captcha.php')), false);
});
