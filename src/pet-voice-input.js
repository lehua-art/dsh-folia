/**
 * pet-voice-input.js — 桌宠语音输入（v0.1，宿主侧录音版）。
 *
 * 为什么不在前端录：DSH 的 Electron 只放行 clipboard/notifications 权限，
 * 音频采集在 Electron 里被权限层拒绝且没有弹窗（工单「追加决定 3」）。所以这里**不碰任何
 * media API**：点一下 → 让宿主录（ffmpeg dshow）→ 拿 text → 走 SSE 逐字回气泡。
 *
 * 判据（test/verify-pet-voice.mjs）用假 postRecord/postChat 覆盖全链路与失败码。
 */
function petVoiceInputCreate(deps) {
  const options = deps || {};
  const postRecord = options.postRecord;
  const postChat = options.postChat;
  const onText = typeof options.onText === 'function' ? options.onText : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onState = typeof options.onState === 'function' ? options.onState : () => {};
  /**
   * barge-in（P1）：**录音一开始**先停掉正在播的朗读。
   * 做成注入点而不是在这里直接引用 petSpeakStop：模块在构建期被内联进同一作用域，
   * 直接引用会把“朗读”与“录音”焊死；注入后判据也能用假函数断言调用顺序。
   */
  const onBeforeRecord = typeof options.onBeforeRecord === 'function' ? options.onBeforeRecord : () => {};

  let active = false;

  async function finishWithText(text) {
    if (!text) return;
    onText(text);
    if (typeof postChat === 'function') await postChat(text, onState);
  }

  async function start() {
    if (active) return true;
    active = true;
    // ⚠️ 顺序是判据：先打断朗读，再开麦（用户一说话就把桌宠的声音掐掉）
    try { onBeforeRecord(); } catch { /* 打断失败不能挡住录音 */ }
    onState({ state: 'listening' });
    let result;
    try {
      result = await postRecord({});
    } catch (error) {
      active = false;
      onError({ code: (error && error.code) || 'network', message: String((error && error.message) || error) });
      return false;
    }
    const doc = result || {};
    if (doc.ok !== true) {
      active = false;
      onError({ code: doc.code || 'record-failed', message: doc.hint || '' });
      return false;
    }
    onState({ state: 'transcribing', text: doc.text });
    try {
      await finishWithText(String(doc.text || ''));
    } catch (error) {
      onError({ code: 'network', message: String((error && error.message) || error) });
      return false;
    } finally {
      active = false;
      onState({ state: 'idle' });
    }
    return true;
  }

  function stop() { active = false; onState({ state: 'idle' }); }

  // ⚠️ 必须把 postChat 暴露出去：桌宠的「打字说」走 petVoiceIn.postChat(text)，
  //    上一版这里只返回 start/stop ⇒ typing 发送时 TypeError（输入框消失、气泡无反应）。
  return { start, stop, isActive: () => active, postChat };
}
