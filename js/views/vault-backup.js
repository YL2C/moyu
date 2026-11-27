import { cloudBackupStatus, refreshEncryptedBackup, watchCloudBackup } from '../cloud-backup.js';
import {
  activateVault, archiveLegacyVault, cloudVault, downloadLegacyArchive, isVaultUnlocked, lockVault,
  previewVault, restoreFromVault, restoreLegacyChat, restoreLegacyStory, rotateVaultPassword, vaultProfile,
} from '../vault-backup.js';
import { el, sheet, toast, saveFile } from '../util.js';
import { vaultContents } from './vault-preview.js';

const hint = text => el('p', { class: 'hint', text });
const dateLabel = time => new Date(time).toLocaleString();
const progressLabels = {
  connecting: '正在连接备份服务器…',
  reading: '正在读取本机存档…',
  processing: '正在核对并加密改动…',
  uploading: '正在上传加密片段…',
  committing: '正在确认云端快照…',
};

export function renderBackupStatus(status, state) {
  const { config, encrypted, unlocked, waiting, running, pending, lastBackup, lastError, vaultProgress } = state;
  let message;
  if (!config?.enabled) message = '已关闭，仅保存本地';
  else if (encrypted && !unlocked) message = '请输入密码以继续备份';
  else if (lastError) message = lastError;
  else if (running) message = encrypted ? progressLabels[vaultProgress?.stage] || '正在准备备份…' : '正在上传旧版备份…';
  else if (waiting || pending) message = encrypted ? '改动已保存，等待自动备份' : '等待上传旧版备份';
  else if (!encrypted) message = '正在使用旧版备份，可在备份设置中启用加密';
  else message = lastBackup ? '自动备份已完成' : '等待首次自动备份';
  status.replaceChildren(el('div', { text: message }));
  if (config?.enabled && running && encrypted && unlocked && vaultProgress) {
    const { stage, processed, total, uploaded } = vaultProgress;
    const determinate = ['processing', 'uploading'].includes(stage) && total > 0;
    status.append(el('progress', { 'aria-label': message, max: determinate ? total : null,
      value: determinate ? processed : null, style: { display: 'block', width: '100%' } }));
    if (Number.isFinite(total)) {
      status.append(el('div', { text: '已检查 ' + processed + ' / ' + total + ' 项 · 云端已确认 ' + uploaded + ' 个数据片段' }));
    }
  }
  if (config?.enabled && !encrypted && pending) status.append(el('div', { text: pending + ' 项待传' }));
  if (lastBackup) status.append(el('div', { text: '最近成功 ' + dateLabel(lastBackup) }));
}

function pass(label, type) {
  return el('input', { type: 'password', autocomplete: type, placeholder: label, 'aria-label': label,
    autocapitalize: 'off', spellcheck: 'false' });
}

export async function openEncryptedBackup({ section = 'browse' } = {}) {
  const titles = { browse: '查看云端存档', settings: '备份密码与设备', legacy: '旧备份加密归档' };
  const dialog = sheet({ title: titles[section] });
  let busy = false;
  const task = work => async () => {
    if (busy || !dialog.body.isConnected) return;
    busy = true;
    try { await work(); }
    catch (error) { toast(error.message, 5500); }
    finally { busy = false; }
  };
  const button = (text, work, primary = false) => el('button', {
    class: 'btn small' + (primary ? ' primary' : ''), onclick: task(work),
  }, text);
  dialog.foot.append(el('button', { class: 'btn', onclick: dialog.close }, '关闭'));

  function passwordForm(config, creating) {
    const pwd = pass(creating ? '设置备份密码（至少 16 个字符）' : '备份密码', creating ? 'new-password' : 'current-password');
    const again = creating ? pass('确认备份密码', 'new-password') : null;
    const remember = el('input', { type: 'checkbox', checked: true });
    dialog.body.append(hint(creating ? '设置密码后，墨游会在设备上加密再上传。' : '请输入备份密码以查看云端存档和继续加密备份。'),
      el('div', { class: 'field' }, pwd, again), el('label', { class: 'row' }, remember, '记住此设备'),
      hint('新设备需要输入备份密码。可以将密码保存在密码管理器里。'),
      button(creating ? '创建加密备份' : '确认密码', async () => {
        if (creating && pwd.value !== again.value) throw new Error('两次密码输入不一致');
        await activateVault(config, { password: pwd.value, remember: remember.checked, create: creating });
        pwd.value = '';
        if (again) again.value = '';
        refreshEncryptedBackup();
        if (creating && !config.enabled) toast('密码已设置。开启云端同步后开始上传。', 4500);
        await show();
      }, true));
  }

  function securitySettings(config) {
    const change = el('details', { class: 'card' }, el('summary', { text: '修改备份密码' }));
    const current = pass('原备份密码', 'current-password');
    const replacement = pass('新备份密码（至少 16 个字符）', 'new-password');
    const repeat = pass('确认新密码', 'new-password');
    change.append(el('div', { class: 'field' }, current, replacement, repeat), button('更新密码', async () => {
      if (replacement.value !== repeat.value) throw new Error('两次新密码输入不一致');
      await rotateVaultPassword(config, current.value, replacement.value);
      current.value = replacement.value = repeat.value = '';
      change.open = false;
      toast('备份密码已更新');
    }));
    dialog.body.append(hint('墨游会使用此设备上的密钥自动加密备份。锁定后，下次需要重新输入备份密码。'),
      button('锁定此设备', async () => {
        await lockVault();
        refreshEncryptedBackup({ locked: true });
        await show();
      }), change);
  }

  function legacyArchives(config, snapshots) {
    const controls = el('div', { class: 'row' });
    controls.append(button('加密归档旧云端备份', async () => {
      if (!(await cloudBackupStatus()).config?.enabled) throw new Error('请先开启云端同步');
      const progress = hint('正在读取旧云端备份…');
      const archive = new AbortController();
      watchCloudBackup(async () => {
        const { config: active } = await cloudBackupStatus();
        if (!active?.enabled || active.url !== config.url || active.token !== config.token) archive.abort();
      }, archive.signal);
      controls.after(progress);
      let count;
      try {
        count = await archiveLegacyVault(config, { signal: archive.signal, onProgress: (done, total) => {
          progress.textContent = '正在加密归档旧云端，' + done + ' / ' + total;
        } });
      } catch (error) {
        if (archive.signal.aborted) throw new Error('旧备份归档已暂停');
        throw error;
      } finally {
        archive.abort();
        progress.remove();
      }
      toast(count ? '旧云端已加密归档 ' + count + ' 项' : '服务器暂无旧云端记录');
      await show();
    }));
    dialog.body.append(controls, hint('归档涵盖旧回收站和旧版每日快照。核对后可按需恢复。'));
    if (!snapshots.length) dialog.body.append(hint('云端还没有旧版加密归档。'));
    for (const snapshot of snapshots) {
      const result = el('div');
      const load = button('查看归档', async () => {
        const { source, count } = await previewVault(config, snapshot);
        load.hidden = true;
        result.append(hint((source || '旧云端档案') + ' · ' + count + ' 条记录'),
          button('查看恢复选项', async () => {
            const data = await downloadLegacyArchive(config, snapshot);
            const choices = el('div');
            for (const story of data.filter(item => item.kind === 'stories' && item.value)) {
              choices.append(el('div', { class: 'row' }, el('span', { text: story.value.title || story.id }),
                button('恢复故事', async () => {
                  await restoreLegacyStory(data, story.device, story.id);
                  toast('已恢复旧故事');
                })));
            }
            for (const device of new Set(data.filter(item => item.kind === 'chat' && !item.deleted).map(item => item.device))) {
              choices.append(el('div', { class: 'row' }, el('span', { text: '聊天 · 设备 ' + device.slice(0, 8) }),
                button('恢复旧聊天到空白聊天库', async () => {
                  await restoreLegacyChat(data, device);
                  toast('已恢复旧聊天');
                })));
            }
            result.querySelector('.vault-legacy-choices')?.remove();
            choices.className = 'vault-legacy-choices';
            result.append(choices);
          }),
          button('导出旧云端 JSON', async () => {
            if (!confirm('导出的旧云端 JSON 可以直接阅读。确定要下载？')) return;
            await saveFile('墨游_旧云端归档.json', JSON.stringify(await downloadLegacyArchive(config, snapshot)));
          }));
      });
      dialog.body.append(el('div', { class: 'card' }, el('strong', { text: dateLabel(snapshot.createdAt) }), load, result));
    }
  }

  function browseSnapshots(config, snapshots, currentDevice) {
    const refresh = button('刷新列表', show);
    if (!snapshots.length) {
      dialog.body.append(hint('云端还没有完成的加密备份。首次上传完成后会在这里显示。'), refresh);
      return;
    }
    const devices = new Map();
    for (const snapshot of snapshots) {
      if (!devices.has(snapshot.device)) devices.set(snapshot.device, []);
      devices.get(snapshot.device).push(snapshot);
    }
    const device = el('select', { 'aria-label': '备份设备' }, ...[...devices.keys()].map(id =>
      el('option', { value: id, text: id === currentDevice ? '本设备' : '设备 ' + id.slice(0, 8) })));
    const version = el('select', { 'aria-label': '备份时间' });
    const content = el('div');
    let sequence = 0;
    async function showSnapshot() {
      const id = ++sequence;
      const snapshot = devices.get(device.value).find(item => item.id === version.value);
      content.replaceChildren(hint('正在读取云端快照…'));
      try {
        const preview = await previewVault(config, snapshot);
        if (id !== sequence || !content.isConnected) return;
        const actions = el('details', { class: 'card' }, el('summary', { text: '恢复到本机' }));
        for (const [scope, label] of [['all', '恢复全部'], ['story', '仅恢复跑团和讨论'], ['chat', '仅恢复聊天、资料和记忆']]) {
          actions.append(button(label, async () => {
            if (!window.dispatchEvent(new Event('moyu:before-migration', { cancelable: true })))
              throw new Error('请等生成完成后再恢复');
            if (!confirm('恢复会替换本机对应内容。确认' + label + '？')) return;
            const restoredAppearance = await restoreFromVault(config, snapshot, scope);
            toast(restoredAppearance ? '已恢复，正在重新打开墨游' : '存档已恢复，部分界面偏好未能保存', 4000);
            dialog.close();
            setTimeout(() => location.reload(), 450);
          }));
        }
        content.replaceChildren(hint('以下内容为只读预览。'), vaultContents(config, snapshot, preview, button), actions);
      } catch (error) {
        if (id === sequence) content.replaceChildren(hint(error.message), button('重新读取', showSnapshot));
      }
    }
    function showDevice() {
      version.replaceChildren(...devices.get(device.value).map((snapshot, index) =>
        el('option', { value: snapshot.id, text: (index ? '' : '最新 · ') + dateLabel(snapshot.createdAt) })));
      void showSnapshot();
    }
    device.addEventListener('change', showDevice);
    version.addEventListener('change', () => void showSnapshot());
    if (devices.has(currentDevice)) device.value = currentDevice;
    dialog.body.append(el('div', { class: 'row' }, device, version, refresh), content);
    showDevice();
  }

  async function show() {
    dialog.body.replaceChildren(hint('正在连接备份服务器…'));
    const [state, profile] = await Promise.all([cloudBackupStatus(), vaultProfile()]);
    const { config } = state;
    if (!config?.url || !config?.token) {
      dialog.body.replaceChildren(hint('请先在备份设置中保存服务器地址和服务器口令。'));
      return;
    }
    try {
      const { envelope, snapshots } = await cloudVault(config);
      if (!dialog.body.isConnected) return;
      dialog.body.replaceChildren();
      if (!envelope || !isVaultUnlocked(config, profile) || envelope.keyId !== profile?.keyId) {
        passwordForm(config, !envelope);
      } else if (section === 'settings') {
        securitySettings(config);
      } else {
        const archived = snapshot => snapshot.device === 'legacy' || snapshot.device.startsWith('legacy-');
        const sorted = [...snapshots].sort((a, b) => b.createdAt - a.createdAt);
        if (section === 'legacy') legacyArchives(config, sorted.filter(archived));
        else browseSnapshots(config, sorted.filter(snapshot => !archived(snapshot)), profile.device);
      }
    } catch (error) {
      dialog.body.replaceChildren(hint(error.message), button('重新连接', show));
    }
  }

  await show();
}
