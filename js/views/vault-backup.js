import { cloudBackupStatus, refreshEncryptedBackup, syncCloudBackupNow } from '../cloud-backup.js';
import {
  activateVault, archiveLegacyVault, cloudVault, downloadLegacyArchive,
  lockVault, previewVault, restoreFromVault, restoreLegacyChat, restoreLegacyStory, restoreVaultMaterial, rotateVaultPassword,
} from '../vault-backup.js';
import { el, sheet, toast, saveFile } from '../util.js';
import { MATERIAL_LABELS } from '../deeptalk-materials.js';

function pass(label, type) {
  return el('input', { type: 'password', autocomplete: type, placeholder: label, 'aria-label': label,
    autocapitalize: 'off', spellcheck: 'false' });
}

export async function openEncryptedBackup() {
  const dialog = sheet({ title: '加密备份与恢复' });
  let busy = false;
  const task = work => async () => {
    if (busy) return;
    busy = true;
    try { await work(); }
    catch (error) { toast(error.message, 5500); }
    finally { busy = false; }
  };
  const button = (text, work, primary = false) => el('button', {
    class: 'btn small' + (primary ? ' primary' : ''), onclick: task(work),
  }, text);

  async function show() {
    dialog.body.replaceChildren(el('div', { class: 'hint' }, '正在连接加密备份…'));
    const { config, unlocked } = await cloudBackupStatus();
    if (!config?.url || !config?.token) {
      dialog.body.replaceChildren(el('div', { class: 'hint' }, '请先在备份设置中保存服务器地址和服务器口令。'));
      return;
    }
    const { envelope, snapshots } = await cloudVault(config);
    dialog.body.replaceChildren();
    if (!unlocked || !envelope) {
      const creating = !envelope;
      const pwd = pass(creating ? '设置备份密码（至少 16 个字符）' : '备份密码', creating ? 'new-password' : 'current-password');
      const again = creating ? pass('确认备份密码', 'new-password') : null;
      const remember = el('input', { type: 'checkbox', checked: true });
      dialog.body.append(el('div', { class: 'field' }, pwd, again),
        el('label', { class: 'row' }, remember, '记住此设备'),
        el('p', { class: 'hint' }, '可以把备份密码存进密码管理器。换设备时需要输入，忘记密码则无法从云端解开副本。'),
        button(creating ? '创建加密备份' : '解锁加密备份', async () => {
          if (creating && pwd.value !== again.value) throw new Error('两次密码输入不一致');
          await activateVault(config, { password: pwd.value, remember: remember.checked, create: creating });
          pwd.value = '';
          if (again) again.value = '';
          refreshEncryptedBackup();
          if (creating && !config.enabled) toast('加密备份已建立。打开云端同步开关后开始上传。', 5000);
          await show();
        }, true));
      return;
    }

    const controls = el('div', { class: 'row' });
    controls.append(
      button('锁定此设备', async () => {
        await lockVault();
        refreshEncryptedBackup({ locked: true });
        await show();
      }),
      button('备份现在的内容', async () => {
        if (!config.enabled) throw new Error('请先开启云端同步');
        await syncCloudBackupNow();
        const state = await cloudBackupStatus();
        if (state.lastError) throw new Error(state.lastError);
        await show();
      }, true),
      button('加密归档旧云端备份', async () => {
        const progress = el('p', { class: 'hint', role: 'status' });
        controls.after(progress);
        let count;
        try {
          count = await archiveLegacyVault(config, { onProgress: (done, total) => {
            progress.textContent = '正在加密归档旧云端，' + done + ' / ' + total;
          } });
        } finally { progress.remove(); }
        toast(count ? '旧云端已加密归档 ' + count + ' 项' : '服务器暂无旧云端记录');
        await show();
      })
    );
    dialog.body.append(controls, el('p', { class: 'hint' }, '旧云端归档包括回收站和旧版每日快照。原来的副本会保留，供你核对。'));

    const change = el('details', { class: 'card' }, el('summary', { text: '修改备份密码' }));
    const current = pass('原备份密码', 'current-password');
    const replacement = pass('新备份密码（至少 16 个字符）', 'new-password');
    const repeat = pass('确认新密码', 'new-password');
    change.append(el('div', { class: 'field' }, current, replacement, repeat), button('更新密码', async () => {
      if (replacement.value !== repeat.value) throw new Error('两次新密码输入不一致');
      await rotateVaultPassword(config, current.value, replacement.value);
      current.value = replacement.value = repeat.value = '';
      toast('备份密码已更新');
      await show();
    }));
    dialog.body.append(change);

    if (!snapshots.length) dialog.body.append(el('p', { class: 'hint' }, '云端还没有完成的加密备份。'));
    for (const snapshot of snapshots) {
      const details = el('div', { class: 'card' }, el('strong', { text: new Date(snapshot.createdAt).toLocaleString() }),
        el('div', { class: 'hint', text: snapshot.device.startsWith('legacy') ? '旧版云端归档' : '加密快照 · 设备 ' + snapshot.device.slice(0, 8) }));
      const actions = el('div', { class: 'row' });
      details.append(button('解密预览', async () => {
        const preview = await previewVault(config, snapshot);
        actions.replaceChildren();
        if (preview.kind === 'legacy') {
          actions.append(el('div', { class: 'hint', text: (preview.source || '旧云端档案') + ' · ' + preview.count + ' 条记录' }),
            button('查看可恢复的旧存档', async () => {
              const data = await downloadLegacyArchive(config, snapshot);
              const choices = el('div');
              for (const story of data.filter(item => item.kind === 'stories' && item.value)) {
                choices.append(el('div', { class: 'row' }, el('span', { text: story.value.title || story.id }),
                  button('恢复故事', async () => { await restoreLegacyStory(data, story.device, story.id); toast('已恢复旧故事'); })));
              }
              for (const device of new Set(data.filter(item => item.kind === 'chat' && !item.deleted).map(item => item.device))) {
                choices.append(el('div', { class: 'row' }, el('span', { text: '聊天 · 设备 ' + device.slice(0, 8) }),
                  button('恢复旧聊天到空白聊天库', async () => { await restoreLegacyChat(data, device); toast('已恢复旧聊天'); })));
              }
              actions.append(choices);
            }),
            button('导出旧云端 JSON', async () => {
              if (!confirm('导出的旧云端 JSON 可以直接阅读。确定要下载？')) return;
              const data = await downloadLegacyArchive(config, snapshot);
              await saveFile('墨游_旧云端归档.json', JSON.stringify(data));
            }));
          return;
        }
        actions.append(el('div', { class: 'hint',
          text: preview.stories + ' 个故事 · ' + preview.turns + ' 轮日常聊天 · ' + preview.materials + ' 份资料' }));
        if (preview.materialKeys.length) {
          const picker = el('select', { 'aria-label': '选择要恢复的资料' },
            ...preview.materialKeys.map(slot => el('option', { value: slot, text: MATERIAL_LABELS[slot] || slot })));
          actions.append(el('div', { class: 'row' }, picker, button('恢复这一份资料', async () => {
            if (!confirm('恢复会替换本机这一份资料及其版本。确认恢复？')) return;
            await restoreVaultMaterial(config, snapshot, picker.value);
            toast('资料已恢复');
          })));
        }
        for (const [scope, label] of [['all', '恢复全部'], ['story', '仅恢复跑团和讨论'], ['chat', '仅恢复聊天和资料']]) {
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
      }), actions);
      dialog.body.append(details);
    }
  }
  try { await show(); }
  catch (error) { dialog.body.replaceChildren(el('div', { class: 'hint', text: error.message })); }
}
