import { backupDatabase, SCHEMA, readChatBackup, restoreChatBackup } from '../db.js';
import { cloudBackupStatus, setCloudBackup, syncCloudBackupNow, watchCloudBackup, listCloudStories, downloadCloudStory, listCloudChats, downloadCloudChat } from '../cloud-backup.js';
import { el, sheet, toast, saveFile, pickRawFile } from '../util.js';
import { openEncryptedBackup } from './vault-backup.js';

export function cloudBackupControls(signal) {
  const toggle = el('input', { type: 'checkbox', role: 'switch' });
  const url = el('input', { type: 'url', 'aria-label': '云端备份地址', placeholder: 'https://你的备份域名', autocomplete: 'off' });
  const token = el('input', { type: 'password', 'aria-label': '云端备份口令', placeholder: '服务器备份口令', autocomplete: 'off' });
  const status = el('div', { class: 'hint', role: 'status' });
  const now = el('button', { class: 'btn small', onclick: () => void syncCloudBackupNow() }, '立即备份');
  const recover = el('button', { class: 'btn small', onclick: () => void openRecovery() }, '查看云端存档与回收站');
  const save = el('button', { class: 'btn small', onclick: () => void change(toggle.checked, true) }, '保存服务器设置');
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
    save.disabled = busy;
    recover.disabled = !state.config?.url;
    if (!editing) {
      url.value = state.config?.url || '';
      token.placeholder = state.config?.token ? '已保存，留空沿用' : '服务器备份口令';
    }
    const latest = state.lastBackup ? ' · 最近成功 ' + new Date(state.lastBackup).toLocaleString() : '';
    status.textContent = (!toggle.checked ? '已关闭，仅保存本地'
      : state.lastError || (state.encrypted && !state.unlocked ? '加密备份待解锁'
        : state.running ? (state.encrypted ? '正在加密备份…' : '正在备份…')
        : state.pending ? '等待补传' : state.encrypted ? '已启用加密备份' : '已启用旧版备份')) +
      (state.pending ? ' · ' + state.pending + ' 项待传' : '') + latest;
  }

  async function change(enabled, saveOnly = false) {
    if (busy) return;
    busy = true;
    for (const action of actions) action.disabled = true;
    try {
      await setCloudBackup({ enabled, saveOnly, url: url.value, token: token.value });
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
    el('div', { class: 'row' }, save, now, recover,
      el('button', { class: 'btn small', onclick: () => void openChatRecovery() }, '聊天备份与恢复')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small primary', onclick: () => void openEncryptedBackup() }, '加密备份与恢复')),
    status,
    el('div', { class: 'hint' }, '加密备份涵盖故事、日常聊天、讨论、资料全文、记忆和个性化设置。')
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


async function openChatRecovery() {
  const dialog = sheet({ title: '日常聊天备份与恢复' });
  const local = el('div', { class: 'row' });
  const cloud = el('div');
  dialog.body.append(local, cloud);
  let busy = false;
  const action = task => async () => {
    if (busy) return;
    busy = true;
    try { await task(); }
    catch (error) { toast(error.message, 5000); }
    finally { busy = false; }
  };
  const download = archive => saveFile('墨游_日常聊天_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(archive));
  async function restore(archive) {
    if (!window.dispatchEvent(new Event('moyu:before-migration', { cancelable: true }))) {
      throw new Error('请等生成完成后再恢复聊天。');
    }
    const existing = await readChatBackup();
    const replace = existing.entries.length > 0;
    if (replace && !confirm('这会替换本机日常聊天记录。建议先导出本机聊天。确认恢复？')) return;
    await restoreChatBackup(archive, { replace });
    toast('日常聊天记录已恢复');
    dialog.close();
  }
  local.append(
    el('button', { class: 'btn small', onclick: action(async () => {
      const archive = await readChatBackup();
      if (!archive.entries.length) throw new Error('本机暂无聊天记录。');
      await download(archive);
    }) }, '导出本机聊天'),
    el('button', { class: 'btn small', onclick: action(async () => {
      const file = await pickRawFile(null);
      if (file) await restore(JSON.parse(await file.text()));
    }) }, '导入聊天备份')
  );
  try {
    const { config } = await cloudBackupStatus();
    if (!config?.url) {
      cloud.append(el('div', { class: 'hint' }, '连接云端备份服务器后，可在这里查看云端聊天。'));
      return;
    }
    cloud.append(el('div', { class: 'hint' }, '正在加载云端聊天…'));
    const entries = await listCloudChats();
    cloud.replaceChildren();
    if (!entries.length) cloud.append(el('div', { class: 'hint' }, '云端还没有聊天备份。'));
    for (const entry of entries) {
      cloud.append(el('div', { class: 'card' },
        el('strong', { text: '日常聊天' }),
        el('div', { class: 'hint' }, entry.turns + ' 轮 · 设备 ' + entry.device.slice(0, 8) + ' · ' + new Date(entry.updatedAt).toLocaleString()),
        el('div', { class: 'row' },
          el('button', { class: 'btn small primary', onclick: action(async () => restore(await downloadCloudChat(entry.device))) }, '恢复到本机'),
          el('button', { class: 'btn small', onclick: action(async () => download(await downloadCloudChat(entry.device))) }, '下载聊天 JSON')
        )
      ));
    }
  } catch (error) {
    cloud.replaceChildren(el('div', { class: 'hint', text: error.message }));
  }
}
