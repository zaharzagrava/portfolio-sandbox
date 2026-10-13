/**
 * The XSS corpus of S25 AS-09: every payload is posted as a post body and as a comment body, and no output may carry
 * an executable construct. Shared by the unit spec (`content.spec.ts`) and `discussions-markdown.e2e-spec.ts`.
 */
export const XSS_CORPUS: ReadonlyArray<
  readonly [name: string, markdown: string]
> = [
  ['script tag', '<script>alert(1)</script>'],
  ['script tag with src', '<script src="https://evil.example/x.js"></script>'],
  ['uppercase script', '<SCRIPT SRC=//evil.example/x.js></SCRIPT>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['img onerror quoted', '<img src="x" onerror="alert(document.cookie)">'],
  ['body onload', '<body onload=alert(1)>'],
  ['div onclick', '<div onclick="alert(1)">click</div>'],
  ['p onmouseover', '<p onmouseover="alert(1)">hover</p>'],
  ['anchor onclick', '<a href="https://ok.example" onclick="alert(1)">x</a>'],
  ['markdown javascript link', '[x](javascript:alert(1))'],
  ['mixed case javascript link', '[x](JaVaScRiPt:alert(1))'],
  ['entity encoded javascript link', '[x](&#106;avascript:alert(1))'],
  ['hex entity javascript link', '[x](&#x6A;avascript:alert(1))'],
  ['tab inside scheme', '[x](java\tscript:alert(1))'],
  ['newline inside scheme', '<a href="java\nscript:alert(1)">x</a>'],
  ['control char inside scheme', '<a href="java\u0001script:alert(1)">x</a>'],
  ['leading whitespace scheme', '[x]( javascript:alert(1))'],
  ['javascript autolink', '<javascript:alert(1)>'],
  ['javascript html anchor', '<a href="javascript:alert(1)">x</a>'],
  ['javascript reference link', '[x][1]\n\n[1]: javascript:alert(1)'],
  [
    'javascript with url param',
    '[x](https://ok.example/?u=javascript:alert(1))',
  ],
  [
    'data html link',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  ],
  ['data anchor', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ['vbscript link', '[x](vbscript:msgbox(1))'],
  ['vbscript anchor', '<a href="vbscript:msgbox(1)">x</a>'],
  ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['object', '<object data="https://evil.example/x.swf"></object>'],
  ['embed', '<embed src="https://evil.example/x.swf">'],
  ['svg onload', '<svg onload=alert(1)></svg>'],
  ['svg script', '<svg><script>alert(1)</script></svg>'],
  ['math', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
  ['form', '<form action="https://evil.example"><input name=a></form>'],
  ['input autofocus', '<input autofocus onfocus=alert(1)>'],
  ['base', '<base href="https://evil.example/">'],
  [
    'meta refresh',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  ],
  [
    'link stylesheet',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
  ],
  [
    'style element',
    '<style>body{background:url(https://evil.example/x)}</style>',
  ],
  ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>'],
  ['style attribute on link', '<a href="https://ok.example" style="x:y">x</a>'],
  ['markdown image', '![x](https://evil.example/t.png)'],
  [
    'markdown image with handler',
    '![x"onerror="alert(1)](https://evil.example/t.png)',
  ],
  ['html comment', '<!-- <script>alert(1)</script> -->'],
  ['conditional comment', '<!--[if IE]><script>alert(1)</script><![endif]-->'],
  ['unclosed tag', '<img src="x" onerror="alert(1)'],
  ['nested malformed tags', '<<script>script>alert(1)<</script>/script>'],
  [
    'broken attribute quotes',
    '<a href="https://ok.example" title="x" onmouseover=alert(1) x=">x</a>',
  ],
  [
    'mutation xss noscript',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ],
  ['mutation xss style', '<style><style/><img src=x onerror=alert(1)>'],
  [
    'mutation xss svg',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  ],
  [
    'mutation xss math',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  ],
  [
    'mutation xss textarea',
    '<textarea><img src=x onerror=alert(1)></textarea>',
  ],
  ['plain onerror text', 'hello onerror=alert(1) world'],
  ['plain javascript text', 'try javascript:alert(1) in the console'],
  ['plain data text', 'see data:text/html,hello for details'],
  ['plain style text', 'a <b style=color:red>b</b>'],
  [
    'code block with script',
    '```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```',
  ],
  ['inline code with handler', '`<img src=x onerror=alert(1)>`'],
  ['html entity script', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['blockquote script', '> <script>alert(1)</script>'],
  [
    'list with image',
    '- ![x](https://evil.example/t.png)\n- <iframe src=x></iframe>',
  ],
];

/** The patterns AS-09 forbids in any response field and in every later read. */
export const FORBIDDEN_OUTPUT: ReadonlyArray<RegExp> = [
  /<script/i,
  /on[a-z]+=/i,
  /javascript:/i,
  /vbscript:/i,
  /data:/i,
  /<img/i,
  /<iframe/i,
  /<svg/i,
  /<style/i,
  / style=/i,
];
