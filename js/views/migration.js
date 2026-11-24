import { el, pickRawFile, saveFile, sheet } from '../util.js';
import { exportMigration, openMigration, restoreMigration, MIGRATION_NOTICE_KEY, MIGRATION_PASSWORD_LENGTH } from '../migration.js';

function checkMigrationReady() {
  if (!window.dispatchEvent(new Event('moyu:before-migration', { cancelable: true }))) {
    throw new Error('等正在生成的内容完成后再迁移');
  }
}

export function migrationControls() {
  const startExport = el('button', { class: 'btn small', onclick: () => migrationDialog() }, '导出完整迁移包');
  const startImport = el('button', { class: 'btn small', onclick: async () => {
    const file = await pickRawFile();
    if (file) migrationDialog(file);
  } }, '导入完整迁移包');

  return el('div', {},
    el('div', { class: 'hint', text: '换设备、网址或主屏幕入口时，可把存档、设置和 API 密钥一起迁移。' }),
    el('div', { class: 'row', style: { marginTop: '8px' } }, startExport, startImport));
}

function migrationDialog(file) {
  const importing = !!file;
  let busy = false;
  let encrypted;
  const password = el('input', { id: 'migration-password', type: 'password', required: true, autocomplete: importing ? 'current-password' : 'new-password' });
  const again = importing ? null : el('input', { id: 'migration-password-again', type: 'password', required: true, autocomplete: 'new-password' });
  const form = el('form', {},
    el('div', { class: 'field' }, el('label', { for: password.id, text: '迁移密码' }), password),
    again ? el('div', { class: 'field' }, el('label', { for: again.id, text: '再输一次密码' }), again) : null);
  const info = el('p', { class: 'hint', text: importing
    ? '导入会用迁移包替换当前入口的墨游数据。请在你自己的墨游网址操作。'
    : `设置至少 ${MIGRATION_PASSWORD_LENGTH} 个字符的密码，导入时需要用到。迁移包在本机加密。` });
  const status = el('div', { class: 'hint', role: 'status' });
  const panel = sheet({
    title: importing ? '导入完整迁移包' : '导出完整迁移包',
    canDismiss: () => !busy,
    onClose: () => { password.value = ''; if (again) again.value = ''; },
  });
  const cancel = el('button', { class: 'btn ghost', onclick: () => panel.close() }, '取消');
  const action = importing ? '解密并恢复' : '加密并导出';
  const submit = el('button', { class: 'btn primary', type: 'submit', form: 'migration-form' }, action);
  form.id = 'migration-form';
  panel.body.append(info, importing ? el('p', { class: 'hint', text: file.name }) : null, form, status);
  panel.foot.append(cancel, submit);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (!encrypted && again && password.value !== again.value) {
      status.textContent = '两次输入的密码不一致';
      return;
    }

    busy = submit.disabled = cancel.disabled = true;
    password.readOnly = true;
    if (again) again.readOnly = true;
    status.textContent = importing ? '正在解密…' : (encrypted ? '正在保存…' : '正在加密…');
    try {
      if (importing) {
        const snapshot = await openMigration(file, password.value);
        checkMigrationReady();
        status.textContent = '正在恢复墨游数据…';
        const restoredAppearance = await restoreMigration(snapshot);
        try {
          sessionStorage.setItem(MIGRATION_NOTICE_KEY, restoredAppearance ? '迁移完成，存档和 API 配置已恢复' : '迁移完成，部分界面状态未能恢复');
        } catch {}
        panel.close();
        window.location.reload();
      } else {
        if (!encrypted) {
          checkMigrationReady();
          encrypted = await exportMigration(password.value);
          form.hidden = true;
          password.required = again.required = false;
          password.value = again.value = '';
        }
        const d = new Date();
        const filename = `墨游_完整迁移_${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.moyu`;
        if (await saveFile(filename, encrypted, encrypted.type)) panel.close();
        else status.textContent = '迁移包已生成，可以再点保存。';
      }
    } catch (error) {
      status.textContent = error?.message || '迁移失败，请重试';
    } finally {
      busy = submit.disabled = cancel.disabled = false;
      password.readOnly = false;
      if (again) again.readOnly = false;
      submit.textContent = encrypted ? '保存迁移包' : action;
    }
  });
}
