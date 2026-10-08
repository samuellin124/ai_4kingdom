<?php
/**
 * Plugin Name: AI4Kingdom Hide Weglot Switcher
 * Description: 全站隱藏 Weglot 右下角的語言切換按鈕；翻譯頁（/en/、/tw/）仍保留，可由網址直接進入。
 * Version:     1.0.0
 *
 * 2026-10 使用者決定不在畫面上提供語言切換，但保留 Weglot 的翻譯版本。
 * 用 mu-plugin 輸出 CSS，而不是改 Weglot 設定或 Elementor 全站 CSS：
 * 登入／帳戶等非 Elementor 頁面也會生效，且不受外掛、主題更新影響。
 * 要恢復按鈕，刪除此檔即可。
 *
 * @package AI4Kingdom
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'wp_head',
	function () {
		echo "<style id=\"a4k-hide-weglot-switcher\">.country-selector.weglot-dropdown,.country-selector.weglot-inline,.weglot_switcher{display:none !important;}</style>\n";
	},
	99
);
