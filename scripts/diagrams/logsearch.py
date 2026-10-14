import math, sys
OUT = sys.argv[1]
FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif'
TH = {
    'light': dict(s=['#2a78d6', '#eb6834', '#1baf7a'], neu='#9b9a94', t1='#0b0b0b', t2='#52514e',
                  grid='#e5e4e0', axis='#b8b7b0', bg='#fcfcfb'),
    'dark': dict(s=['#3987e5', '#d95926', '#199e70'], neu='#77766f', t1='#f0efec', t2='#c3c2b7',
                 grid='#33332f', axis='#5a5954', bg='#1a1a19'),
}
SYS = ['ClickHouse', 'Doris', 'Elasticsearch']


class S:
    def __init__(s, w, h, c):
        s.w, s.h, s.c, s.o = w, h, c, []

    def add(s, x): s.o.append(x)

    def text(s, x, y, t, size=12, fill=None, anchor='start', weight=None):
        w = f' font-weight="{weight}"' if weight else ''
        s.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill or s.c["t2"]}" text-anchor="{anchor}"{w}>{t}</text>')

    def line(s, x1, y1, x2, y2, col, w=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        s.add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" stroke-width="{w}"{d}/>')

    def vbar(s, x, y0, y1, w, col, r=4):
        # bar from baseline y0 up to y1 (y1<y0), rounded top only
        h = y0 - y1
        if h <= 0: return
        r = min(r, w / 2, h)
        s.add(f'<path d="M{x:.1f},{y0:.1f} V{y1 + r:.1f} Q{x:.1f},{y1:.1f} {x + r:.1f},{y1:.1f} H{x + w - r:.1f} '
              f'Q{x + w:.1f},{y1:.1f} {x + w:.1f},{y1 + r:.1f} V{y0:.1f} Z" fill="{col}"/>')

    def hbar(s, x0, y, x1, h, col, r=4):
        w = x1 - x0
        if w <= 0: return
        r = min(r, h / 2, w)
        s.add(f'<path d="M{x0:.1f},{y:.1f} H{x1 - r:.1f} Q{x1:.1f},{y:.1f} {x1:.1f},{y + r:.1f} V{y + h - r:.1f} '
              f'Q{x1:.1f},{y + h:.1f} {x1 - r:.1f},{y + h:.1f} H{x0:.1f} Z" fill="{col}"/>')

    def rect(s, x, y, w, h, col):
        s.add(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{col}"/>')

    def legend(s, x, y, items):
        for lab, col in items:
            s.add(f'<rect x="{x}" y="{y - 9}" width="10" height="10" rx="2" fill="{col}"/>')
            s.text(x + 15, y, lab, 12, s.c['t1'])
            x += 30 + sum(12 if ord(ch) > 127 else 7.2 for ch in lab)

    def svg(s):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s.w} {s.h}" width="{s.w}" height="{s.h}" '
                f'font-family=\'{FONT}\'>\n' + '\n'.join(s.o) + '\n</svg>\n')


def save(name, fn):
    for t, c in TH.items():
        s = fn(c)
        open(f'{OUT}/{name}.{t}.svg', 'w').write(s.svg())


# 1. 压缩比：两个数据集并排（同一 y 轴刻度）
TIERS = ['d0', 't1', 't2a', 't2b', 't3']
NGX = [[27.25, 25.04, 23.27, 90.14, 23.21], [43.49, 42.62, 37.10, 38.45, 30.81], [71.07, 47.11, 46.95, 47.02, 24.55]]
MSG = [[69.66, 47.80, 50.97, 134.07, 44.95], [55.89, 53.49, 57.00, 57.28, 43.44], [116.89, 79.03, 78.98, 78.38, 47.64]]


def compress(c):
    s = S(760, 340, c)
    s.legend(56, 22, list(zip(SYS, c['s'])))
    ymax, top, base = 140, 60, 290
    Y = lambda v: base - (base - top) * v / ymax
    for pi, (title, data, raw) in enumerate([('nginx', NGX, '25.587 GiB'), ('messages', MSG, '12.586 GiB')]):
        x0 = 56 + pi * 360; pw = 330
        s.text(x0, 52, f'{title}（原始 {raw}）', 13, c['t1'], weight='600')
        for v in (0, 20, 40, 60, 80, 100, 120, 140):
            s.line(x0, Y(v), x0 + pw, Y(v), c['grid'])
            if pi == 0: s.text(x0 - 8, Y(v) + 4, f'{v}%', 11, anchor='end')
        gw = pw / 5; bw = 16
        for ti, tier in enumerate(TIERS):
            gx = x0 + ti * gw + (gw - 3 * bw - 4) / 2
            for si in range(3):
                v = data[si][ti]
                bx = gx + si * (bw + 2)
                s.vbar(bx, base, Y(v), bw, c['s'][si])
                if v > 100:
                    s.text(bx + bw / 2, Y(v) - 5, f'{v:.0f}%', 11, c['t1'], 'middle', '600')
            s.text(x0 + ti * gw + gw / 2, base + 18, tier, 12, anchor='middle')
        s.line(x0, Y(100), x0 + pw, Y(100), c['t2'], 1.2, '5 4')
        s.line(x0, base, x0 + pw, base, c['axis'])
    s.text(56 + 690, Y(100) - 6, '落盘 = 原始', 11, anchor='end')
    s.text(56, 332, '落盘 ÷ 原始，越低越省', 11)
    return s


# 2. ES 落盘构成
ESB = [('messages_d0', [57.74, 9.16, 24.90, 8.21]), ('messages_t1', [49.92, 9.94, 34.33, 5.82]),
       ('messages_t3', [0, 19.02, 61.09, 19.90]), ('nginx_d0', [64.20, 7.39, 21.71, 6.69]),
       ('nginx_t1', [54.64, 8.20, 32.35, 4.81])]


def esbreak(c):
    s = S(760, 270, c)
    cols = [c['s'][0], c['s'][1], c['s'][2], c['neu']]
    labs = ['_source', '_id', 'message', '其余']
    s.legend(130, 22, list(zip(labs, cols)))
    x0, x1 = 130, 730; W = x1 - x0
    for ri, (name, parts) in enumerate(ESB):
        y = 44 + ri * 42
        s.text(x0 - 10, y + 18, name, 12, c['t1'], 'end')
        x = x0
        for k, v in enumerate(parts):
            if v == 0:
                continue
            w = W * v / 100
            s.rect(x, y, max(w - 2, 0), 26, cols[k])
            if w > 44:
                s.text(x + (w - 2) / 2, y + 17.5, f'{v:.1f}%', 11, '#ffffff' if k != 3 else c['t1'], 'middle', '600')
            x += w
        if parts[0] == 0:
            s.text(x0 + 4, y - 3, '_source 已禁用', 10)
    for v in (0, 25, 50, 75, 100):
        s.text(x0 + W * v / 100, 262, f'{v}%', 11, anchor='middle')
    return s


# 3. 元数据占落盘
META = [('CK', [('nginx_d0', 4.57), ('nginx_t1', 0.16), ('messages_d0', 9.31), ('messages_t1', 0.17)]),
        ('Doris', [('nginx_d0', 3.57), ('nginx_t1', 1.53), ('messages_d0', 6.38), ('messages_t1', 2.72)]),
        ('ES', [('nginx_d0', 17.36), ('nginx_t1', 29.11), ('messages_d0', 21.31), ('messages_t1', 29.03)])]


def meta(c):
    s = S(760, 420, c)
    s.legend(200, 22, list(zip(SYS, c['s'])))
    x0, x1, xmax = 200, 700, 32
    X = lambda v: x0 + (x1 - x0) * v / xmax
    yend = 42 + 12 * 26 + 2 * 12
    for v in (0, 10, 20, 30):
        s.line(X(v), 40, X(v), yend, c['grid'])
        s.text(X(v), yend + 18, f'{v}%', 11, anchor='middle')
    y = 42
    for gi, (sys_, rows) in enumerate(META):
        for name, v in rows:
            s.text(x0 - 10, y + 15, f'{sys_} · {name}', 12, c['t1'], 'end')
            s.hbar(x0, y, X(v), 20, c['s'][gi])
            s.text(X(v) + 6, y + 15, f'{v:.2f}%', 11, c['t1'])
            y += 26
        y += 12
    s.line(x0, 40, x0, yend, c['axis'])
    return s


# 4. 检索中位延迟（对数刻度）
CASES = ['单词', '英文短语', '中文短语', '多词 AND', '极稀有词', '高选择率', '索引取反', '中文取反', '多词取反']
LAT = [[36.55, 40.17, 36.91, 41.29, 17.44, 17.37, 31.38, 37.34, 29.88],
       [30.82, 24.70, 22.07, 19.04, 18.26, 17.34, 316.58, 329.56, 311.88],
       [6.29, 4.63, 3.80, 3.45, 3.31, 3.03, 2.48, 2.46, 1.94]]


def latency(c):
    s = S(760, 330, c)
    s.legend(56, 22, list(zip(SYS, c['s'])))
    top, base, x0, x1 = 44, 280, 56, 740
    lo, hi = 0, 3  # 1 ms .. 1000 ms
    Y = lambda v: base - (base - top) * (math.log10(v) - lo) / (hi - lo)
    for v, lab in ((1, '1 ms'), (10, '10'), (100, '100'), (1000, '1000')):
        s.line(x0, Y(v), x1, Y(v), c['grid'])
        s.text(x0 - 8, Y(v) + 4, lab, 11, anchor='end')
    gw = (x1 - x0) / 9; bw = 16
    for ci, name in enumerate(CASES):
        gx = x0 + ci * gw + (gw - 3 * bw - 4) / 2
        for si in range(3):
            s.vbar(gx + si * (bw + 2), base, Y(LAT[si][ci]), bw, c['s'][si])
        s.text(x0 + ci * gw + gw / 2, base + 18, name, 11, anchor='middle')
    s.line(x0, base, x1, base, c['axis'])
    s.line(x0 + 6 * gw, top - 4, x0 + 6 * gw, base, c['t2'], 1, '3 3')
    s.text(x0 + 6 * gw + 6, top + 6, '取反类 →', 11)
    s.text(x0, 318, 'p50 中位延迟（毫秒，对数刻度）；hot 模式，跨 5 档 × 2 数据集', 11)
    return s


# 5. LIKE vs 索引谓词读取量（对数刻度）
LIKE = [('nginx_d0 英文短语', 25.46, 0.091, '280×'), ('nginx_t2b 英文短语', 25.46, 1.920, '13.3×'),
        ('messages_d0 英文短语', 12.71, 0.091, '140×'), ('nginx_d0 中文短语', 25.51, 0.091, '280×'),
        ('messages_d0 中文短语', 12.59, 0.091, '138×')]


def like(c):
    s = S(760, 320, c)
    s.legend(56, 22, [('LIKE', c['neu']), ('索引谓词', c['s'][0])])
    top, base, x0, x1 = 56, 270, 56, 740
    lo, hi = -2, 2  # 0.01 .. 100 GiB
    Y = lambda v: base - (base - top) * (math.log10(v) - lo) / (hi - lo)
    for v, lab in ((0.01, '0.01'), (0.1, '0.1'), (1, '1'), (10, '10'), (100, '100 GiB')):
        s.line(x0, Y(v), x1, Y(v), c['grid'])
        s.text(x0 - 8, Y(v) + 4, lab, 11, anchor='end')
    gw = (x1 - x0) / 5; bw = 34
    for i, (name, a, b, r) in enumerate(LIKE):
        gx = x0 + i * gw + (gw - 2 * bw - 2) / 2
        s.vbar(gx, base, Y(a), bw, c['neu'])
        s.vbar(gx + bw + 2, base, Y(b), bw, c['s'][0])
        s.text(x0 + i * gw + gw / 2, Y(a) - 8, r, 12, c['t1'], 'middle', '600')
        s.text(x0 + i * gw + gw / 2, base + 18, name, 11, anchor='middle')
    s.line(x0, base, x1, base, c['axis'])
    s.text(x0, 310, 'ClickHouse 全表覆盖查询的 read_bytes；柱顶为读取量倍数', 11)
    return s


save('logsearch-01', compress)
save('logsearch-02', esbreak)
save('logsearch-03', meta)
save('logsearch-04', latency)
save('logsearch-05', like)
