import sys
out=sys.argv[1]
TH={
 'light':dict(box='#fbfbfc',stroke='#52525b',text='#1f1f23',sub='#676C7E',grp='#a1a1aa',
              chip='#eaf5ec',chipS='#15803d',ghost='#b91c1c',ghostF='#fdeaea',arrow='#0D32B2'),
 'dark': dict(box='#242428',stroke='#a1a1aa',text='#e8e8ea',sub='#BAC2DE',grp='#52525b',
              chip='#16291c',chipS='#4ade80',ghost='#f87171',ghostF='#2e1a1a',arrow='#CBA6f7'),
}
FONT='-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif'
W,H=760,334
def svg(data,t,c):
    o=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family=\'{FONT}\'>',
       f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c["arrow"]}"/></marker></defs>']
    # query node
    o.append(f'<rect x="250" y="12" width="260" height="48" rx="8" fill="{c["box"]}" stroke="{c["stroke"]}" stroke-width="1.5"/>')
    o.append(f'<text x="380" y="34" text-anchor="middle" font-size="15" fill="{c["text"]}">分布式表查询</text>')
    o.append(f'<text x="380" y="52" text-anchor="middle" font-size="12" fill="{c["sub"]}">每个分片任选一个副本</text>')
    for si,(gx,reps) in enumerate(zip((20,390),data)):
        o.append(f'<rect x="{gx}" y="108" width="350" height="212" rx="10" fill="none" stroke="{c["grp"]}" stroke-width="1.5" stroke-dasharray="6 4"/>')
        o.append(f'<text x="{gx+16}" y="130" font-size="14" font-weight="600" fill="{c["text"]}">分片 {si+1}</text>')
        for ri,rows in enumerate(reps):
            rx=gx+20+ri*165; cx=rx+72
            o.append(f'<line x1="{380+(-60 if si==0 else 60)}" y1="60" x2="{cx}" y2="140" stroke="{c["arrow"]}" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#a)"/>')
            o.append(f'<rect x="{rx}" y="144" width="145" height="162" rx="8" fill="{c["box"]}" stroke="{c["stroke"]}" stroke-width="1.5"/>')
            o.append(f'<text x="{cx}" y="168" text-anchor="middle" font-size="13" fill="{c["text"]}">副本 {ri+1}</text>')
            for k,(v,ok) in enumerate(rows):
                y=182+k*40
                if ok:
                    o.append(f'<rect x="{cx-45}" y="{y}" width="90" height="30" rx="6" fill="{c["chip"]}" stroke="{c["chipS"]}" stroke-width="1.3"/>')
                    o.append(f'<text x="{cx}" y="{y+20}" text-anchor="middle" font-size="14" fill="{c["text"]}">{v}</text>')
                else:
                    o.append(f'<rect x="{cx-45}" y="{y}" width="90" height="30" rx="6" fill="{c["ghostF"]}" stroke="{c["ghost"]}" stroke-width="1.3" stroke-dasharray="4 3"/>')
                    o.append(f'<text x="{cx}" y="{y+20}" text-anchor="middle" font-size="13" fill="{c["ghost"]}">{v} 未同步</text>')
    o.append('</svg>')
    return '\n'.join(o)
T=lambda *a:[(x,True) for x in a]
D={
 'inconsistent-01': [[T(1,3),T(2)],[T(6),T(4,5)]],
 'inconsistent-02': [[T(1,2,3),T(1,2)+[(3,False)]],[T(4,5,6),T(4)+[(5,False),(6,False)]]],
}
for n,d in D.items():
    for t,c in TH.items():
        open(f'{out}/{n}.{t}.svg','w').write(svg(d,t,c))
