import { backupDatabase, SCHEMA } from '../db.js';
import { cloudBackupStatus, setCloudBackup, syncCloudBackupNow, watchCloudBackup, listCloudStories, downloadCloudStory } from '../cloud-backup.js';
import { el, sheet, toast, saveFile } from '../util.js';

export function cloudBackupControls(signal) {
  const toggle = el('input', { type: 'checkbox', role: 'switch' });
  const url = el('input', { type: 'url', 'aria-label': '云端备份地址', placeholder: 'https://你的备份域名', autocomplete: 'off' });
  const token = el('input', { type: 'password', 'aria-label': '云端备份口令', placeholder: '服务器备份口令', autocomplete: 'off' });
  const status = el('div', { class: 'hint', role: 'status' });
  const now = el('button', { class: 'btn small', onclick: () => void syncCloudBackupNow() }, '立即备份');
  const recover = el('button', { class: 'btn small', onclick: () => void openRecovery() }, '查看云端存档与回收站');
  const save = el('button', { class: 'btn small', onclick: () => void change(true) }, '保存服务器设置');
  const actions = [toggle, now, save];
  let editing = false;
  let busy = false;
  let lastRefresh = 0;

  async function refresh() {
    const generation = ++lastRefresh;
    const state = await cloudBackupStatus();
    if (signal.aborted || generation !== lastRefresh) return;
    toggle.checked = !!state.config?.enabled;
    toggle.disabled = busy;
    now.disabled = busy || !toggle.checked || state.running;
    save.disabled = busy || !toggle.checked;
    recover.disabled = !state.config?.url;
    if (!editing) {
      url.value = state.config?.url || '';
      token.placeholder = state.config?.token ? '已保存，留空沿用' : '服务器备份口令';
    }
    const latest = state.lastBackup ? ' · 最近成功 ' + new Date(state.lastBackup).toLocaleString() : '';
    status.textContent = (!toggle.checked ? '已关闭，仅保存本地'
      : state.lastError || (state.running ? '正在备份…' : state.pending ? '等待补传' : '已启用')) +
      (state.pending ? ' · ' + state.pending + ' 项待传' : '') + latest;
  }

  async function change(enabled) {
    if (busy) return;
    busy = true;
    for (const action of actions) action.disabled = true;
    try {
      await setCloudBackup({ enabled, url: url.value, token: token.value });
      editing = false;
      token.value = '';
    } catch (error) {
      toast(error.message, 4500);
      if (enabled) (url.value ? token : url).focus();
    } finally { busy = false; await refresh(); }
  }

  for (const input of [url, token]) input.addEventListener('input', () => { editing = true; });
  toggle.addEventListener('change', () => void change(toggle.checked));
  watchCloudBackup(() => void refresh(), signal);
  void refresh();
  return el('div', { class: 'card' },
    el('label', { class: 'row', style: { fontWeight: '600' } }, toggle, '开启/关闭云端同步'),
    el('div', { class: 'field' }, url, token),
    el('div', { class: 'row' }, save, now, recover),
    status,
    el('div', { class: 'hint' }, '自动备份跑团故事、章节与番外。关闭后暂停上传，重新开启后补传。API 密钥和独立聊天记录不会上传。')
  );
}

async function openRecovery() {
  const s = sheet({ title: '云端存档与回收站' });
  s.body.append(el('div', { class: 'hint' }, '正在加载…'));
  try {
    const stories = await listCloudStories();
    s.body.replaceChildren();
    if (!stories.length) s.body.append(el('div', { class: 'hint' }, '云端还没有可恢复的故事。'));
    for (const entry of stories) {
      let running = false;
      const restore = (download) => async () => {
        if (running) return;
        running = true;
        try {
          const data = await downloadCloudStory(entry.device, entry.id);
          if (download) {
            const { story, nodes, extras } = data;
            await saveFile((story.title || '墨游云端存档').replace(/[\\/:*?"<>|]/g, '_') + '.json',
              JSON.stringify({ app: 'moyu', schema: SCHEMA, stories: [story], nodes, extras }));
          } else {
            await backupDatabase.restore(data);
            toast('已恢复到本机故事列表');
          }
        } catch (error) { toast(error.message, 5000); }
        finally { running = false; }
      };
      s.body.append(el('div', { class: 'card' },
        el('strong', { text: entry.title || '未命名故事' }),
        el('div', { class: 'hint' }, [entry.deleted ? '回收站' : '云端存档', '设备 ' + entry.device.slice(0, 8),
          new Date(entry.updatedAt).toLocaleString()].join(' · ')),
        el('div', { class: 'row' },
          el('button', { class: 'btn small primary', onclick: restore(false) }, '恢复到本机'),
          el('button', { class: 'btn small', onclick: restore(true) }, '下载备份 JSON'))
      ));
    }
  } catch (error) {
    s.body.replaceChildren(el('div', { class: 'hint', text: error.message }));
  }
}
