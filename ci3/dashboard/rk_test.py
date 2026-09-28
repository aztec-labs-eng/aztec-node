#!/usr/bin/env python3
"""Tests for the dashboard's ANSI to HTML rendering.

  python3 rk_test.py
"""
import unittest

from rk import ansi_to_html
from rk_core import hyperlink


class AnsiToHtmlTest(unittest.TestCase):
    def test_relative_links_keep_their_target(self):
        html = ansi_to_html(hyperlink('/section/next', 'next') + ' ' + hyperlink('/1757000000000', 'log'))
        self.assertIn('<a href="/section/next">next</a>', html)
        self.assertIn('<a href="/1757000000000">log</a>', html)

    def test_absolute_links_keep_their_target(self):
        html = ansi_to_html(hyperlink('https://github.com/x/y/pull/1', 'pr') + ' https://example.com/a')
        self.assertIn('<a href="https://github.com/x/y/pull/1">pr</a>', html)
        self.assertIn('<a href="https://example.com/a">https://example.com/a</a>', html)

    def test_unsafe_link_targets_are_dropped(self):
        html = ansi_to_html(hyperlink('javascript:alert(1)', 'x') + hyperlink('//evil.example/a', 'y'))
        self.assertNotIn('javascript:', html)
        self.assertNotIn('evil.example', html)


if __name__ == '__main__':
    unittest.main()
