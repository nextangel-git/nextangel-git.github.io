<?php
declare(strict_types=1);
require __DIR__ . '/../server/sync/vk.php';
$fixture = file_get_contents(__DIR__ . '/fixtures/vk-community-public.html');
$passed = 0;
function check(bool $condition, string $message): void {
    global $passed;
    if (!$condition) throw new RuntimeException($message);
    $passed++;
}
function collectHtml(string $html): array {
    return (new JksVkSync(static function ($url, $post) use ($html) { return $html; }))->collect();
}
function fails(string $html, string $reason): void {
    try { collectHtml($html); } catch (RuntimeException $error) { check(true, $reason); return; }
    throw new RuntimeException('Expected failure: ' . $reason);
}
function post(string $id, string $text = 'Тестовая запись', string $date = '16 ноября 2026 в 7:13', string $attributes = ''): string {
    return '<div class="wcommunity_post"><a class="wcommunity_post_date" href="/wall' . $id . '" ' . $attributes . '>' . $date . '</a><div class="wall_post_text">' . $text . '</div></div>';
}
$calls = [];
$sync = new JksVkSync(static function ($url, $post) use ($fixture, &$calls) { $calls[] = [$url, $post]; return $fixture; });
$posts = $sync->collect();
check(count($posts) === 4, 'four real fixture posts');
check($calls === [[JksVkSync::URL, null]], 'one fixed public GET, no cookies or token');
check($posts[0]['id'] === '-189230176_232' && $posts[3]['id'] === '-189230176_228', 'latest owner IDs first');
check($posts[0]['date'] === null, 'relative date is not guessed');
check($posts[1]['date'] === '2026-11-16', 'absolute Russian date becomes ISO');
check(count($sync->getReport()['warnings']) === 1, 'missing date is reported');
check($sync->getReport()['warnings'][0]['post'] === '-189230176_232', 'warning identifies post');
check(strpos($posts[0]['text'], "\n\n") !== false, 'paragraph newlines survive');
check(strpos($posts[0]['text'], 'Собственнику квартиры') !== false, 'hidden expanded text survives');
check(strpos($posts[0]['text'], 'Показать ещё') === false, 'expand UI is excluded');
check(strpos($posts[0]['text'], 'запись закреплена') === false, 'header UI is excluded');
check(strpos($posts[0]['text'], '🏠') !== false, 'emoji alt text survives');
check($posts[0]['url'] === 'https://vk.ru/wall-189230176_232', 'canonical public post URL');
foreach ($posts as $value) {
    check(count(preg_split('//u', $value['text'], -1, PREG_SPLIT_NO_EMPTY)) <= 500, '500 Unicode character limit');
    check(preg_match('//u', $value['text']) === 1, 'valid UTF-8 without mbstring');
}
$many = '';
foreach ([1, 17, 2, 16, 3, 15, 4, 14, 5, 13, 6, 12] as $id) $many .= post('-189230176_' . $id);
$latest = collectHtml($many);
check(count($latest) === 10, 'maximum ten posts');
check($latest[0]['id'] === '-189230176_17' && $latest[9]['id'] === '-189230176_3', 'pinned/unsorted posts sorted before limiting');
$extra = post('-189230176_999', 'Начало<br><a href="https://example.test">ссылка</a> [club123|группа]<button>Показать ещё</button><span style="display: none"><br>Полный текст</span>');
$text = collectHtml($fixture . $extra)[0]['text'];
check($text === "Начало\nссылка группа\nПолный текст", 'HTML and VK mention labels become plain text');
$long = collectHtml($fixture . post('-189230176_999', str_repeat('🏠я', 400)))[0]['text'];
check($long === str_repeat('🏠я', 250), 'Unicode truncation does not cut multibyte characters');
$timestamp = (string)gmmktime(12, 0, 0, 11, 16, 2026);
check(collectHtml($fixture . post('-189230176_999', 'Тест', 'вчера', 'data-time="' . $timestamp . '"'))[0]['date'] === '2026-11-16', 'explicit Unix time produces ISO date');
$withoutYear = new JksVkSync(static function () use ($fixture) { return $fixture . post('-189230176_999', 'Тест', '16 ноября'); });
check($withoutYear->collect()[0]['date'] === null, 'year is not invented');
check(count($withoutYear->getReport()['warnings']) === 2, 'all omitted dates reported');
fails('', 'empty response');
fails('<html>Войдите в VK</html>', 'login shell');
fails('<form><input name="captcha_sid"></form>', 'CAPTCHA page');
fails($fixture . '<input type="password">', 'auth gate even when posts remain in HTML');
fails($fixture . '<input name="captcha_key">', 'CAPTCHA gate even when posts remain');
fails(post('-189230176_1') . post('-189230176_2') . post('-189230176_3'), 'partial feed');
fails(str_replace('/wall-189230176_232', '/wall-123_232', $fixture), 'foreign owner');
fails(str_replace('/wall-189230176_232', 'https://example.test/wall-189230176_232', $fixture), 'foreign host');
fails($fixture . post('-189230176_232'), 'duplicate IDs');
fails(str_replace('wall_post_text', 'changed_text_class', $fixture), 'markup drift');
fails($fixture . post('-189230176_999', ''), 'empty post cannot replace an existing feed');
fails($fixture . post('-189230176_999', 'Тест', '31 февраля 2026'), 'invalid calendar date');
fails($fixture . post('-189230176_999', 'Тест', '1 января 2099'), 'future calendar date');
fails($fixture . post('-189230176_999', 'Тест', 'вчера', 'data-time="' . (time() + 3600) . '"'), 'future timestamp');
fails($fixture . post('-189230176_999', 'Тест', 'вчера', 'data-time="not-a-date"'), 'malformed timestamp');
fails($fixture . post('-189230176_999', 'Тест', 'непонятная дата'), 'unknown date cannot silently replace known date');
fails($fixture . "\xff", 'invalid UTF-8');
fails(str_repeat('x', 2000001), 'response size limit');
$errorPropagated = false;
try { (new JksVkSync(static function () { throw new RuntimeException('network failed'); }))->collect(); }
catch (RuntimeException $error) { $errorPropagated = $error->getMessage() === 'network failed'; }
check($errorPropagated, 'network failure is propagated to preservation logic');
echo json_encode(['passed' => $passed, 'network_used' => false], JSON_THROW_ON_ERROR) . "\n";
