import sys, math
out = sys.argv[1]
TH = {
 'light': dict(box='#fbfbfc', stroke='#52525b', text='#1f1f23', sub='#676C7E', lbl='#ffffff',
               c=['#1f6feb', '#2da44e', '#d4740f']),
 'dark':  dict(box='#242428', stroke='#a1a1aa', text='#e8e8ea', sub='#BAC2DE', lbl='#1b1b1f',
               c=['#6ea8fe', '#56d364', '#f0a35a']),
}
FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif'

def head(W, H):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family=\'{FONT}\'>']

def edge(o, t, a, b, col, label, at=0.5):
    o.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{col}" stroke-width="3.5" stroke-linecap="round"/>')
    x = a[0] + (b[0]-a[0])*at; y = a[1] + (b[1]-a[1])*at
    w = 14 + 8.5*len(label.encode('gbk'))
    o.append(f'<rect x="{x-w/2:.1f}" y="{y-12:.1f}" width="{w:.1f}" height="24" rx="12" fill="{t["lbl"]}" stroke="{col}" stroke-width="1.6"/>')
    o.append(f'<text x="{x:.1f}" y="{y+5:.1f}" text-anchor="middle" font-size="13" font-weight="600" fill="{t["text"]}">{label}</text>')

def node(o, t, p, name, sub=None, r=34):
    o.append(f'<circle cx="{p[0]}" cy="{p[1]}" r="{r}" fill="{t["box"]}" stroke="{t["stroke"]}" stroke-width="1.6"/>')
    if sub:
        o.append(f'<text x="{p[0]}" y="{p[1]-4}" text-anchor="middle" font-size="15" font-weight="600" fill="{t["text"]}">{name}</text>')
        o.append(f'<text x="{p[0]}" y="{p[1]+15}" text-anchor="middle" font-size="12" fill="{t["sub"]}">{sub}</text>')
    else:
        o.append(f'<text x="{p[0]}" y="{p[1]+5}" text-anchor="middle" font-size="15" font-weight="600" fill="{t["text"]}">{name}</text>')

def d1(t):
    W, H = 640, 260; o = head(W, H)
    for i in range(3):
        x = 120 + i*200
        a, b = (x, 55), (x, 205)
        edge(o, t, a, b, t['c'][i], f'S{i+1}')
        node(o, t, a, f'ck{2*i+1}'); node(o, t, b, f'ck{2*i+2}')
    o.append('</svg>'); return '\n'.join(o)

def d2(t):
    W, H = 560, 390; o = head(W, H)
    p1, p2, p3 = (280, 70), (450, 320), (110, 320)
    edge(o, t, p1, p2, t['c'][0], 'S1')
    edge(o, t, p2, p3, t['c'][1], 'S2')
    edge(o, t, p1, p3, t['c'][2], 'S3')
    node(o, t, p1, 'ck1', 'S1R1, S3R2', 50)
    node(o, t, p2, 'ck2', 'S2R1, S1R2', 50)
    node(o, t, p3, 'ck3', 'S3R1, S2R2', 50)
    o.append('</svg>'); return '\n'.join(o)

def d3(t):
    W, H = 600, 470; o = head(W, H)
    ck1, ck2, ck3, ck4 = (120, 60), (480, 60), (480, 360), (120, 360)
    c = t['c']
    edge(o, t, ck1, ck2, c[0], 'cluster1 S1')
    edge(o, t, ck4, ck3, c[0], 'cluster1 S2')
    edge(o, t, ck2, ck3, c[1], 'cluster2 S1')
    edge(o, t, ck4, ck1, c[1], 'cluster2 S2')
    edge(o, t, ck1, ck3, c[2], 'cluster3 S1', 0.3)
    edge(o, t, ck2, ck4, c[2], 'cluster3 S2', 0.3)
    for p, n in ((ck1, 'ck1'), (ck2, 'ck2'), (ck3, 'ck3'), (ck4, 'ck4')):
        node(o, t, p, n)
    # legend
    lx = 95
    for i, (name, tb) in enumerate((('cluster1', 'tbl1'), ('cluster2', 'tbl2'), ('cluster3', 'tbl3'))):
        x = lx + i*150
        o.append(f'<line x1="{x}" y1="438" x2="{x+30}" y2="438" stroke="{c[i]}" stroke-width="3.5" stroke-linecap="round"/>')
        o.append(f'<text x="{x+40}" y="443" font-size="13" fill="{t["text"]}">{name} · {tb}</text>')
    o.append('</svg>'); return '\n'.join(o)

for n, f in (('deploy-topology-01', d1), ('deploy-topology-02', d2), ('deploy-topology-03', d3)):
    for k, t in TH.items():
        open(f'{out}/{n}.{k}.svg', 'w').write(f(t))
