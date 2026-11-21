// dsh-fish-brain · 界面半（浏览器半）
// 形态：左侧栏「记忆」入口 + 主区域「小鱼记忆系统」面板。
// 页面是系统面板（状态 / 功能 / 搜索 / 下一步），搜索只是其中一块，不是整页。

window.__ModuleLoader__.load({
  id: 'dsh-fish-brain',
  factory: (require) => {
    // DSH 客户端模块约定：factory 是普通函数，必须自建 module/exports。
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'fish-brain';

    const brainIcon = (size) =>
      h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 3.5c-2.1 0-3.8 1.4-4.4 3.3-1.7.5-2.9 2.1-2.9 3.9 0 1.1.4 2.1 1.1 2.9-.2.5-.3 1.1-.3 1.7 0 2.7 2.2 4.9 4.9 4.9.5 0 .9-.1 1.3-.2.4.1.8.2 1.3.2 2.7 0 4.9-2.2 4.9-4.9 0-.6-.1-1.2-.3-1.7.7-.8 1.1-1.8 1.1-2.9 0-1.8-1.2-3.4-2.9-3.9-.6-1.9-2.3-3.3-4.4-3.3z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
      );

    /** 相对时间：每条消息按它自己的时间算。 */
    function relativeTime(t, now = Date.now()) {
      const ms = Number(t);
      if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
      const diff = Math.max(0, now - ms);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      if (diff < minute) return '刚刚';
      if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;

      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      if (ms >= midnight.getTime()) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
      if (ms >= midnight.getTime() - day) return `昨天 ${hh}:${mm}`;
      if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

      const nowDate = new Date(now);
      if (d.getFullYear() === nowDate.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
      return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    }

    function absoluteTime(t) {
      const d = new Date(Number(t));
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString('zh-CN', { hour12: false });
    }

    function conversationLabel(key) {
      const raw = String(key || '');
      if (raw.startsWith('group:')) return `群 ${raw.slice(6)}`;
      if (raw.startsWith('private:')) return `私聊 ${raw.slice(8)}`;
      return raw || '未知会话';
    }

    const inputStyle = {
      flex: '1 1 auto',
      minWidth: '0',
      padding: '8px 11px',
      borderRadius: '8px',
      border: '1px solid rgba(127,127,127,.3)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      outline: 'none',
    };

    const buttonStyle = {
      padding: '8px 14px',
      borderRadius: '8px',
      border: '1px solid rgba(127,127,127,.3)',
      background: 'rgba(127,127,127,.1)',
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
      flex: '0 0 auto',
    };

    const cardStyle = {
      flex: '1 1 0',
      minWidth: '120px',
      padding: '12px 14px',
      borderRadius: '10px',
      border: '1px solid rgba(127,127,127,.22)',
      background: 'rgba(127,127,127,.05)',
    };

    const sectionStyle = { marginTop: '22px' };

    const sectionTitleStyle = { fontSize: '13px', fontWeight: 600, margin: '0 0 10px', opacity: 0.9 };

    function Metric({ label, value, hint }) {
      return h(
        'div',
        { style: cardStyle },
        h('div', { style: { fontSize: '11px', opacity: 0.6, marginBottom: '6px' } }, label),
        h('div', { style: { fontSize: '20px', fontWeight: 600, lineHeight: 1.2 } }, value),
        hint ? h('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '4px' } }, hint) : null,
      );
    }

    function SearchSection() {
      const [items, setItems] = React.useState([]);
      const [query, setQuery] = React.useState('');
      const [conv, setConv] = React.useState('');
      const [conversations, setConversations] = React.useState([]);
      const [pending, setPending] = React.useState(false);
      const [error, setError] = React.useState('');

      async function load(q, key) {
        setPending(true);
        setError('');
        try {
          const params = new URLSearchParams();
          if (q) params.set('q', q);
          if (key) params.set('key', key);
          params.set('limit', '60');
          const res = await fetch(`/api/fish-brain/search?${params.toString()}`, {
            headers: { accept: 'application/json' },
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setItems(Array.isArray(data.items) ? data.items : []);
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setPending(false);
        }
      }

      React.useEffect(() => {
        let alive = true;
        fetch('/api/fish-brain/stats', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (alive && data.ok && Array.isArray(data.byConversation)) setConversations(data.byConversation);
          })
          .catch(() => {});
        load('', '');
        return () => { alive = false; };
      }, []);

      return h(
        'div',
        { style: sectionStyle },
        h('h2', { style: sectionTitleStyle }, '搜索记忆'),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px' } },
          h('input', {
            value: query,
            placeholder: '搜一句话、一个人、一件事…',
            style: inputStyle,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') load(query, conv);
            },
          }),
          h(
            'select',
            {
              value: conv,
              style: { ...inputStyle, flex: '0 0 190px', cursor: 'pointer' },
              onChange: (event) => {
                setConv(event.target.value);
                load(query, event.target.value);
              },
            },
            h('option', { value: '' }, '全部会话'),
            conversations.map((row) => h('option', { key: row.key, value: row.key }, `${conversationLabel(row.key)}（${row.count}）`)),
          ),
          h('button', { type: 'button', style: buttonStyle, disabled: pending, onClick: () => load(query, conv) }, pending ? '查询中…' : '搜索'),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              onClick: () => {
                setQuery('');
                setConv('');
                load('', '');
              },
            },
            '最新',
          ),
        ),
        error ? h('div', { style: { color: '#d9534f', fontSize: '12px', marginBottom: '8px' } }, `出错了：${error}`) : null,
        h(
          'div',
          {
            style: {
              maxHeight: '340px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
              paddingRight: '4px',
            },
          },
          items.length === 0 && !pending
            ? h('div', { style: { opacity: 0.55, fontSize: '13px' } }, '没有匹配的记忆。')
            : items.map((item) =>
                h(
                  'div',
                  {
                    key: item.id,
                    title: absoluteTime(item.t),
                    style: {
                      padding: '9px 11px',
                      borderRadius: '8px',
                      border: '1px solid rgba(127,127,127,.18)',
                      background: 'rgba(127,127,127,.04)',
                    },
                  },
                  h(
                    'div',
                    { style: { fontSize: '11px', opacity: 0.6, marginBottom: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                    h('span', null, relativeTime(item.t)),
                    h('span', null, conversationLabel(item.key)),
                    h('span', null, item.role === 'assistant' ? '她' : '对方'),
                  ),
                  h('div', { style: { fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.text),
                ),
              ),
        ),
      );
    }

    /** 人物档案：紧凑列表，点开一行再改。她也可以用 person-edit.mjs 自己改。 */
    function PeopleSection() {
      const [drafts, setDrafts] = React.useState({});
      const [order, setOrder] = React.useState([]);
      const [openId, setOpenId] = React.useState('');
      const [error, setError] = React.useState('');
      const [saving, setSaving] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch('/api/fish-brain/people', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            if (!data.ok) { setError(data.error || '读取失败'); return; }
            const map = {};
            for (const person of data.people || []) map[person.id] = { ...person };
            setDrafts(map);
            setOrder((data.people || []).map((person) => person.id));
          })
          .catch((cause) => { if (alive) setError(String(cause && cause.message ? cause.message : cause)); });
        return () => { alive = false; };
      }, []);

      function update(id, field, value) {
        setDrafts((current) => ({ ...current, [id]: { ...(current[id] || { id }), [field]: value } }));
      }

      async function save(id) {
        setSaving(id);
        try {
          const res = await fetch('/api/fish-brain/people', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, patch: drafts[id] || {} }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          setError('');
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        }
        setSaving('');
      }

      const input = (id, field, placeholder) =>
        h('input', {
          value: (drafts[id] && drafts[id][field]) || '',
          placeholder,
          onChange: (event) => update(id, field, event.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', background: 'transparent',
            border: '1px solid rgba(128,128,128,0.3)', borderRadius: '5px',
            padding: '4px 7px', fontSize: '12px', color: 'inherit', outline: 'none',
          },
        });

      const label = (text, node) =>
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', opacity: 0.62 } }, text, node);

      return h(
        'section',
        { style: { marginTop: '22px' } },
        h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' } }, '人物档案'),
        h('p', { style: { margin: '0 0 10px', fontSize: '12px', opacity: 0.6 } },
          '第一次说话时自动建档；她也会自己更新。这里只做查看和纠正，点一行展开。'),
        error ? h('div', { style: { color: '#d9534f', fontSize: '12px', marginBottom: '8px' } }, error) : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          order.map((id) => {
            const person = drafts[id] || {};
            const summary = [person.relation, person.attitude].filter(Boolean).join(' · ');
            const open = openId === id;
            return h(
              'div',
              { key: id, style: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: '8px', padding: '8px 12px' } },
              h(
                'button',
                {
                  onClick: () => setOpenId(open ? '' : id),
                  style: {
                    display: 'flex', width: '100%', alignItems: 'baseline', gap: '10px',
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'inherit', textAlign: 'left',
                  },
                },
                h('span', { style: { fontSize: '13px', fontWeight: 600 } }, person.display || id),
                h('span', { style: { fontSize: '11px', opacity: 0.55 } }, summary || '还没填'),
                h('span', { style: { marginLeft: 'auto', fontSize: '11px', opacity: 0.45 } }, open ? '收起' : '展开'),
              ),
              open
                ? h(
                  'div',
                  { style: { marginTop: '8px' } },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px 12px' } },
                    label('称呼', input(id, 'display', '她怎么叫')),
                    label('关系', input(id, 'relation', '爸爸/朋友/群友')),
                    label('态度', input(id, 'attitude', '护短/客气/爱怼')),
                    label('语气', input(id, 'tone', '撒娇/损/正经')),
                    label('禁忌', input(id, 'taboos', '不能提的')),
                    label('备注', input(id, 'notes', '喜好/近况')),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
                    h('button', {
                      onClick: () => save(id),
                      disabled: saving === id,
                      style: {
                        border: '1px solid rgba(128,128,128,0.4)', borderRadius: '5px',
                        background: 'transparent', color: 'inherit', fontSize: '11px',
                        padding: '3px 10px', cursor: 'pointer', opacity: saving === id ? 0.5 : 1,
                      },
                    }, saving === id ? '保存中…' : '保存'),
                  ),
                )
                : null,
            );
          }),
        ),
      );
    }

    /** 3D 记忆星图：只画记忆，不画会话；类型分团，权重决定大小。 */
    function Galaxy3D() {
      const canvasRef = React.useRef(null);
      const sceneRef = React.useRef({ points: [], projected: [] });
      const [selected, setSelected] = React.useState(null);
      const [error, setError] = React.useState('');
      const [ready, setReady] = React.useState(false);

      const kinds = [
        { key: 'fact', label: '事实', color: [106, 169, 255], x: -240, y: 80, z: 0 },
        { key: 'event', label: '事件', color: [177, 140, 255], x: 240, y: 80, z: 0 },
        { key: 'impression', label: '印象', color: [95, 209, 160], x: -150, y: -160, z: 90 },
        { key: 'emotion', label: '情绪', color: [255, 159, 107], x: 150, y: -160, z: -90 },
        { key: 'promise', label: '约定', color: [255, 127, 191], x: 0, y: 200, z: 0 },
        { key: 'memory', label: '旧记忆', color: [200, 210, 230], x: 0, y: -230, z: -150 },
      ];

      React.useEffect(() => {
        let alive = true;
        fetch('/api/fish-brain/memory-graph', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            if (!data.ok) { setError(data.error || '读取失败'); return; }
            const entries = data.entries || [];
            const points = [
              { kind: 'center', x: 0, y: 0, z: 0, size: 13, color: [190, 220, 255], sprite: glowSprite([190, 220, 255], 54) },
            ];
            // 星尘
            for (let i = 0; i < 220; i += 1) {
              const a = Math.random() * Math.PI * 2;
              const b = Math.acos(2 * Math.random() - 1);
              const r = 340 + Math.random() * 260;
              points.push({
                kind: 'bg',
                x: Math.sin(b) * Math.cos(a) * r,
                y: Math.sin(b) * Math.sin(a) * r,
                z: Math.cos(b) * r,
                size: 0.5 + Math.random() * 1.2,
                color: [180, 200, 240],
              });
            }
            for (const kind of kinds) {
              points.push({
                kind: 'anchor', kindKey: kind.key, label: kind.label,
                x: kind.x, y: kind.y, z: kind.z,
                size: 9, color: kind.color,
                sprite: glowSprite(kind.color, 40),
              });
            }
            const groups = new Map();
            for (const entry of entries) {
              const list = groups.get(entry.kind) || [];
              list.push(entry);
              groups.set(entry.kind, list);
            }
            for (const kind of kinds) {
              const list = groups.get(kind.key) || [];
              list.forEach((entry, index) => {
                const angle = index * 2.399963;
                const radius = 18 + Math.sqrt(index) * 24;
                const weight = Number(entry.weight) || 0.4;
                points.push({
                  kind: 'mem',
                  entry,
                  kindKey: kind.key,
                  x: kind.x + Math.cos(angle) * radius,
                  y: kind.y + Math.sin(angle) * radius * 0.72,
                  z: kind.z + Math.sin(angle * 1.7) * radius,
                  size: 1.6 + weight * 3.6,
                  color: kind.color,
                });
              });
            }
            sceneRef.current = { points, projected: [] };
            setReady(true);
          })
          .catch((cause) => { if (alive) setError(String(cause && cause.message ? cause.message : cause)); });
        return () => { alive = false; };
      }, []);

      function glowSprite(color, radius) {
        const size = Math.max(8, Math.ceil(radius * 2));
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},0.5)`);
        g.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();
        return canvas;
      }

      React.useEffect(() => {
        if (!ready) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let frame = 0;
        let rotation = 0;
        let previous = performance.now();
        let lastPaint = 0;
        let visible = true;
        const observer = typeof IntersectionObserver === 'function'
          ? new IntersectionObserver((list) => { visible = list.some((entry) => entry.isIntersecting); }, { threshold: 0.02 })
          : null;
        if (observer) observer.observe(canvas);

        const draw = (now) => {
          frame = requestAnimationFrame(draw);
          if (!visible) return;
          if (now - lastPaint < 33) return;
          const dt = Math.min(80, now - previous);
          previous = now;
          lastPaint = now;
          rotation += dt * 0.00018;

          const width = canvas.width;
          const height = canvas.height;
          const cx = width / 2;
          const cy = height / 2;
          const fov = 820;
          ctx.clearRect(0, 0, width, height);

          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const projected = [];
          const anchors = new Map();

          // 投影直接写在 point 上（每帧少造 ~300 个对象），另存 pz 免得覆盖原始 z
          for (const point of sceneRef.current.points) {
            const x = point.x * cos - point.z * sin;
            const pz = point.x * sin + point.z * cos;
            const scale = fov / (fov + pz);
            point.sx = cx + x * scale;
            point.sy = cy + point.y * scale;
            point.scale = scale;
            point.pz = pz;
            projected.push(point);
            if (point.kind === 'anchor') anchors.set(point.kindKey, point);
          }

          // 连线：记忆 → 类型团
          ctx.lineWidth = 0.55;
          for (const item of projected) {
            if (item.kind !== 'mem') continue;
            const anchor = anchors.get(item.kindKey);
            if (!anchor) continue;
            ctx.strokeStyle = `rgba(150,190,255,${0.035 + 0.03 * item.scale})`;
            ctx.beginPath();
            ctx.moveTo(anchor.sx, anchor.sy);
            ctx.lineTo(item.sx, item.sy);
            ctx.stroke();
          }

          projected.sort((a, b) => a.pz - b.pz);
          for (const item of projected) {
            const [r, g, b] = item.color;
            const depth = Math.max(0.25, Math.min(1.15, item.scale));
            if (item.kind === 'center') {
              if (item.sprite) ctx.drawImage(item.sprite, item.sx - item.sprite.width / 2, item.sy - item.sprite.height / 2);
              ctx.fillStyle = 'rgba(245,250,255,0.95)';
              ctx.beginPath();
              ctx.arc(item.sx, item.sy, item.size * 0.45, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = 'rgba(225,238,255,0.8)';
              ctx.font = '12px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('她', item.sx, item.sy + item.size + 16);
            } else if (item.kind === 'anchor') {
              if (item.sprite) ctx.drawImage(item.sprite, item.sx - item.sprite.width / 2, item.sy - item.sprite.height / 2);
              ctx.fillStyle = `rgba(${r},${g},${b},${0.75 * depth})`;
              ctx.beginPath();
              ctx.arc(item.sx, item.sy, item.size * 0.55, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = `rgba(225,236,255,${0.7 * depth})`;
              ctx.font = '12px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(item.label, item.sx, item.sy + item.size + 14);
            } else if (item.kind === 'bg') {
              ctx.fillStyle = `rgba(${r},${g},${b},${0.18 * depth})`;
              ctx.beginPath();
              ctx.arc(item.sx, item.sy, item.size, 0, Math.PI * 2);
              ctx.fill();
            } else {
              const twinkle = 0.7 + 0.3 * Math.sin(now * 0.002 + item.sx * 0.05);
              ctx.fillStyle = `rgba(${r},${g},${b},${0.55 * depth * twinkle})`;
              ctx.beginPath();
              ctx.arc(item.sx, item.sy, item.size, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          sceneRef.current.projected = projected.filter((item) => item.kind === 'mem');
        };

        frame = requestAnimationFrame(draw);
        return () => {
          cancelAnimationFrame(frame);
          if (observer) observer.disconnect();
        };
      }, [ready]);

      function pick(event) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (event.clientX - rect.left) * scaleX;
        const y = (event.clientY - rect.top) * scaleY;
        const hit = sceneRef.current.projected
          .map((item) => ({ item, distance: Math.hypot(item.sx - x, item.sy - y) }))
          .filter((entry) => entry.distance < entry.item.size + 7)
          .sort((a, b) => a.distance - b.distance)[0];
        if (!hit) return;
        setSelected(hit.item.entry);
      }

      const kindLabel = (key) => (kinds.find((kind) => kind.key === key) || {}).label || key;

      return h(
        'section',
        { style: { marginTop: '22px' } },
        h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' } }, '记忆星图'),
        h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.6 } },
          '每颗星是一条记忆，不是聊天记录；越大越重，颜色是类型。点星看内容。'),
        h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', opacity: 0.7, marginBottom: '4px' } },
          ...kinds.map((kind) => h('span', { key: kind.key, style: { color: `rgb(${kind.color.join(',')})` } }, `● ${kind.label}`)),
        ),
        h('div', { style: { fontSize: '11px', opacity: 0.5, marginBottom: '8px' } },
          '「旧记忆」是迁移前留下的条目，没有分类，所以都挤在同一团。'),
        error ? h('div', { style: { color: '#d9534f', fontSize: '12px', marginBottom: '8px' } }, error) : null,
        h(
          'div',
          { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' } },
          h('canvas', {
            ref: canvasRef,
            width: 900,
            height: 560,
            onClick: pick,
            style: {
              width: '100%', maxWidth: '900px', height: 'auto', cursor: 'pointer',
              background: 'radial-gradient(circle at 50% 45%, rgba(30,45,85,0.55), rgba(4,6,14,0.92))',
              border: '1px solid rgba(120,150,220,0.16)', borderRadius: '14px',
              boxShadow: 'inset 0 0 80px rgba(40,70,140,0.25)',
            },
          }),
          selected
            ? h(
              'div',
              { style: { flex: '1 1 260px', minWidth: '240px', maxHeight: '560px', overflowY: 'auto' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, kindLabel(selected.kind)),
              h('div', { style: { fontSize: '11px', opacity: 0.55, marginBottom: '8px' } },
                `${selected.date}${selected.source ? ` · ${selected.source}` : ''}`),
              h('div', { style: { fontSize: '13px', lineHeight: 1.75 } }, selected.text),
            )
            : null,
        ),
      );
    }

    function Roadmap() {
      const rows = [
        ['人物档案', '称呼、关系、态度、语气、禁忌（上面可编辑）', '已接上'],
        ['记忆权限', '群与群隔离；私聊能看所有群；迁移前的旧记忆所有人可见', '已接上'],
        ['时间注入', '每条记忆带时间，召回时按半衰期加权', '已接上'],
        ['写入策略', '一段对话结束 3 分钟后判断一次，只记结论', '已接上'],
        ['记忆召回', '出现「还记得 / 上次」这类信号才检索，最多 5 条', '已接上'],
        ['投喂系统', 'token 折算鱼粮、每日饭量', '待做'],
        ['星系视图', '记忆的分布与遗忘（上面已画）', '已接上'],
      ];
      return h(
        'div',
        { style: sectionStyle },
        h('h2', { style: sectionTitleStyle }, '系统状态'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          rows.map(([name, desc, status]) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '10px',
                  padding: '8px 11px',
                  borderRadius: '8px',
                  border: '1px solid rgba(127,127,127,.14)',
                  opacity: 0.72,
                },
              },
              h('span', { style: { fontSize: '13px', fontWeight: 500, minWidth: '70px' } }, name),
              h('span', { style: { fontSize: '12px', flex: '1 1 auto', opacity: 0.75 } }, desc),
              h('span', { style: { fontSize: '11px', opacity: 0.55 } }, status),
            ),
          ),
        ),
      );
    }

    function MemoryPanel() {
      const [stats, setStats] = React.useState(null);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch('/api/fish-brain/stats', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            if (data.ok) setStats(data);
            else setError(data.error || '读取失败');
          })
          .catch((cause) => { if (alive) setError(String(cause && cause.message ? cause.message : cause)); });
        return () => { alive = false; };
      }, []);

      return h(
        'div',
        { style: { height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '28px 36px 56px', fontFamily: 'inherit' } },
        h('h1', { style: { fontSize: '20px', fontWeight: 600, margin: '0 0 6px' } }, '小鱼记忆系统'),
        h(
          'p',
          { style: { margin: '0 0 18px', fontSize: '13px', opacity: 0.62, lineHeight: 1.7 } },
          '这是她的记忆库管理台：DSH 通过它调用、协调小鱼的记忆。下面是库的状态，以及已经接上的功能。',
        ),
        error ? h('div', { style: { color: '#d9534f', fontSize: '13px', marginBottom: '12px' } }, `读取失败：${error}`) : null,
        h(
          'div',
          { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          h(Metric, { label: '消息', value: stats ? String(stats.messages) : '—', hint: '原始对话' }),
          h(Metric, { label: '人物', value: stats ? String(stats.people) : '—', hint: '白名单里的账号' }),
          h(Metric, { label: '会话', value: stats ? String(stats.conversations) : '—', hint: '私聊 + 群' }),
          h(Metric, { label: '记忆条目', value: stats ? String(stats.memoryEntries ?? stats.memories) : '—', hint: 'diary.md 里' }),
        ),
        h(PeopleSection),
        h(Galaxy3D),
        h(SearchSection),
        h(Roadmap),
        h(
          'div',
          { style: { marginTop: '22px', fontSize: '11px', opacity: 0.5, lineHeight: 1.7 } },
          '库位置：D:\\fish\\brain\\data　·　桥接与面板共用同一份库　·　备份 = 复制这个文件夹',
        ),
      );
    }

    function MemoryIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      return brainIcon(size);
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: '记忆' },
          MemoryIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPanel),
      );
    }

    const inject = ['slots'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
