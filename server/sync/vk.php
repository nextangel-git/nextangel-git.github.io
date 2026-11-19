<?php
declare(strict_types=1);

/** Read-only public widget collector. The runner owns persistence and publication. */
final class JksVkSync
{
    public const URL = 'https://vk.com/widget_community.php?app=0&width=350px&_ver=1&gid=189230176&mode=4&url=https%3A%2F%2Fjks.ooo%2F&height=400';
    private $fetch;
    private array $report = [];

    public function __construct(callable $fetch) { $this->fetch = $fetch; }
    public function getReport(): array { return $this->report; }

    public function collect(): array
    {
        $this->report = ['source' => 'vk_public_widget', 'warnings' => []];
        $html = ($this->fetch)(self::URL, null);
        if (!is_string($html) || strlen($html) > 2000000 || !preg_match('//u', $html)) {
            throw new RuntimeException('VK: invalid or oversized UTF-8 response');
        }
        if (!class_exists('DOMDocument')) throw new RuntimeException('VK: PHP DOM extension is required');
        // HTTP already converted the bytes to UTF-8. Legacy widget meta charset still
        // says Windows-1251 and otherwise makes libxml reinterpret/truncate the input.
        $html = preg_replace('/<meta\b[^>]*>/i', '', $html);
        $document = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        try {
            $loaded = $document->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        } finally { libxml_clear_errors(); libxml_use_internal_errors($previous); }
        if (!$loaded) throw new RuntimeException('VK: HTML could not be parsed');
        $xpath = new DOMXPath($document);
        // A real challenge/login form is an error. Bundled JS may legitimately mention CAPTCHA.
        if ($xpath->query('//input[@name="captcha_sid" or @name="captcha_key" or @type="password"]')->length) {
            throw new RuntimeException('VK: authentication or CAPTCHA page received');
        }
        $nodes = $xpath->query('//*[contains(concat(" ",normalize-space(@class)," ")," wcommunity_post ")]');
        if ($nodes->length < 4 || $nodes->length > 100) throw new RuntimeException('VK: incomplete public feed (expected at least four posts)');
        $posts = [];
        foreach ($nodes as $node) {
            $dates = $xpath->query('.//a[contains(concat(" ",normalize-space(@class)," ")," wcommunity_post_date ")]', $node);
            $texts = $xpath->query('.//*[contains(concat(" ",normalize-space(@class)," ")," wall_post_text ")]', $node);
            if ($dates->length !== 1 || $texts->length !== 1) throw new RuntimeException('VK: post structure changed');
            $href = $dates->item(0)->getAttribute('href');
            if (!preg_match('~^(?:https://(?:vk\.com|vk\.ru))?/wall(-189230176_([1-9][0-9]{0,9}))$~D', $href, $match)) {
                throw new RuntimeException('VK: unexpected post owner or link');
            }
            $id = $match[1];
            if (isset($posts[$id])) throw new RuntimeException('VK: duplicate post ID');
            $text = $this->text($texts->item(0));
            $text = str_replace(["\r", "\xc2\xa0"], ['', ' '], $text);
            $text = preg_replace('/[\t ]+/u', ' ', $text);
            $text = preg_replace('/ *\n */u', "\n", $text);
            $text = preg_replace('/\n{3,}/u', "\n\n", $text);
            $text = preg_replace('~\[(?:id|club|public|https?://)[^\]|]+\|([^\]]+)\]~u', '$1', $text);
            $text = trim($text);
            if ($text === '') throw new RuntimeException('VK: empty post text; previous feed must be retained');
            preg_match('/^.{1,500}/us', $text, $excerpt);
            $posts[$id] = ['id' => $id, 'text' => $excerpt[0], 'date' => $this->date($dates->item(0), $id), 'url' => 'https://vk.ru/wall' . $id];
        }
        // Wall IDs increase within one owner, so a pinned old post cannot displace recent posts.
        uasort($posts, static function (array $a, array $b): int {
            return (int)explode('_', $b['id'])[1] <=> (int)explode('_', $a['id'])[1];
        });
        $posts = array_slice(array_values($posts), 0, 10);
        $this->report['posts'] = count($posts);
        return $posts;
    }

    private function text(DOMNode $node): string
    {
        if ($node instanceof DOMText) return $node->nodeValue;
        if (!($node instanceof DOMElement)) return '';
        if (in_array(strtolower($node->tagName), ['button', 'script', 'style', 'noscript'], true)) return '';
        if (preg_match('/(?:^|\s)PostTextMore(?:\s|$)/', $node->getAttribute('class'))) return '';
        if ($node->tagName === 'br') return "\n";
        if ($node->tagName === 'img') return $node->getAttribute('alt');
        $result = '';
        foreach ($node->childNodes as $child) $result .= $this->text($child);
        return $result;
    }

    private function date(DOMElement $anchor, string $id): ?string
    {
        foreach (['data-time', 'data-date', 'data-timestamp'] as $attribute) {
            if (!$anchor->hasAttribute($attribute)) continue;
            $value = $anchor->getAttribute($attribute);
            if (!preg_match('/^[0-9]{10}$/D', $value)) throw new RuntimeException('VK: invalid timestamp');
            $timestamp = (int)$value;
            if ($timestamp < 1104537600 || $timestamp > time()) throw new RuntimeException('VK: future or invalid timestamp');
            return gmdate('Y-m-d', $timestamp);
        }
        $value = trim(preg_replace('/\s+/u', ' ', $anchor->textContent));
        $months = ['января'=>1, 'февраля'=>2, 'марта'=>3, 'апреля'=>4, 'мая'=>5, 'июня'=>6, 'июля'=>7, 'августа'=>8, 'сентября'=>9, 'октября'=>10, 'ноября'=>11, 'декабря'=>12];
        $monthPattern = implode('|', array_keys($months));
        if (preg_match('/^(\d{1,2}) (' . $monthPattern . ') (20\d{2})(?: в ([0-2]?\d):([0-5]\d))?$/uD', $value, $match)) {
            $day = (int)$match[1]; $month = $months[$match[2]]; $year = (int)$match[3];
            if (!checkdate($month, $day, $year) || (isset($match[4]) && (int)$match[4] > 23)) throw new RuntimeException('VK: invalid calendar date');
            $date = sprintf('%04d-%02d-%02d', $year, $month, $day);
            if ($date > gmdate('Y-m-d')) throw new RuntimeException('VK: future post date');
            return $date;
        }
        if (!preg_match('/^(?:(?:сегодня|вчера)(?: в [0-2]?\d:[0-5]\d)?|\d{1,2} (' . $monthPattern . ')(?: в [0-2]?\d:[0-5]\d)?)$/uD', $value)) {
            throw new RuntimeException('VK: unknown date format');
        }
        $this->report['warnings'][] = ['post' => $id, 'code' => 'date_without_absolute_year', 'message' => 'Дата не сохранена: виджет не передал Unix-время или полную календарную дату.'];
        return null;
    }
}
