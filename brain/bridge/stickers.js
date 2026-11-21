// 表情包库：收藏收到的表情/图片，可以命名，之后按名字或编号发出去。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ENTRIES = 300;

export class StickerStore {
  constructor(dir) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.indexPath = path.join(dir, 'index.json');
    this.entries = [];
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.load();
  }

  load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      this.entries = Array.isArray(doc.entries) ? doc.entries : [];
    } catch {
      this.entries = [];
    }
  }

  save() {
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.indexPath);
  }

  add({ buf, mediaType, sourceKey = '', sender = '', summary = '' }) {
    if (!buf || !buf.length) return null;
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const existing = this.entries.find((entry) => entry.hash === hash);
    if (existing) return existing;

    const ext = mediaType.includes('png') ? 'png'
      : mediaType.includes('gif') ? 'gif'
        : mediaType.includes('webp') ? 'webp' : 'jpg';
    const file = path.join(this.filesDir, `${hash}.${ext}`);
    fs.writeFileSync(file, buf);

    const entry = {
      id: this.entries.length ? Math.max(...this.entries.map((item) => item.id)) + 1 : 1,
      hash,
      file,
      mediaType,
      label: '',
      sourceKey,
      sender,
      summary: String(summary ?? '').slice(0, 60),
      t: Date.now(),
    };
    this.entries.push(entry);
    this.prune();
    this.save();
    return entry;
  }

  prune() {
    if (this.entries.length <= MAX_ENTRIES) return;
    const dropCount = this.entries.length - MAX_ENTRIES;
    const unlabeled = this.entries.filter((entry) => !entry.label);
    const drop = unlabeled.slice(0, dropCount);
    for (const entry of drop) {
      try { fs.unlinkSync(entry.file); } catch {}
    }
    const dropIds = new Set(drop.map((entry) => entry.id));
    this.entries = this.entries.filter((entry) => !dropIds.has(entry.id));
  }

  label(id, label) {
    const entry = this.entries.find((item) => item.id === Number(id));
    if (!entry) return null;
    entry.label = String(label).trim().slice(0, 20);
    this.save();
    return entry;
  }

  find(query) {
    const q = String(query ?? '').trim();
    if (!q) return null;
    return this.entries.find((entry) => String(entry.id) === q)
      ?? this.entries.find((entry) => entry.label && entry.label === q)
      ?? this.entries.find((entry) => entry.label && entry.label.includes(q))
      ?? null;
  }

  labeled(limit = 20) {
    return this.entries.filter((entry) => entry.label).slice(-limit);
  }

  read(entry) {
    try { return fs.readFileSync(entry.file); } catch { return null; }
  }
}
