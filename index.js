import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'dual-tavern-bridge';

let ws = null;
let currentRoomId = null;
let isWaitingForPartner = false;
let pendingMessage = null;
let partnerCharacter = null;
let isRolePlayMode = false;
let partnerUserId = null;
let mainUIVisible = false;
let chatMessages = []; // 存储聊天消息
let isChatUIMinimized = false;


const defaultSettings = {
  enabled: false,
  serverUrl: 'ws://localhost:8765',
  roomId: '',
  autoSync: true,
  rolePlayMode: false
};

// ===== 调试辅助函数 =====
function debugLog(category, message, data = null) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[DTB ${timestamp}] [${category}]`;

  if (data) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

function getWebSocketStatus() {
  if (!ws) return 'NULL';

  const states = {
    0: 'CONNECTING',
    1: 'OPEN',
    2: 'CLOSING',
    3: 'CLOSED'
  };

  return states[ws.readyState] || 'UNKNOWN';
}

// ===== 设置管理 =====
function loadSettings() {
  const context = SillyTavern.getContext();
  const { extensionSettings } = context;

  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }

  return extensionSettings[MODULE_NAME];
}

function saveSettings() {
  saveSettingsDebounced();
}

// ===== WebSocket 连接管理 =====
function connectToServer() {
  const settings = loadSettings();

  debugLog('CONNECT', '开始连接到服务器', { url: settings.serverUrl });

  if (ws && ws.readyState === WebSocket.OPEN) {
    toastr.info('已连接到服务器', 'Dual Tavern Bridge');
    return;
  }

  if (ws) {
    debugLog('CONNECT', '清理旧连接');
    ws.close();
    ws = null;
  }

  try {
    ws = new WebSocket(settings.serverUrl);
    debugLog('CONNECT', 'WebSocket 对象已创建');

    ws.onopen = () => {
      debugLog('CONNECT', '✅ 连接成功');
      toastr.success('已连接到中转服务器', 'Dual Tavern Bridge');
      updateConnectionStatus(true);
    };

    ws.onmessage = (event) => {
      debugLog('MESSAGE', '收到服务器消息', event.data);
      try {
        const message = JSON.parse(event.data);
        handleServerMessage(message);
      } catch (error) {
        console.error('消息解析错误:', error);
      }
    };

    ws.onerror = (error) => {
      debugLog('ERROR', 'WebSocket 错误', error);
      toastr.error('服务器连接错误', 'Dual Tavern Bridge');
    };

    ws.onclose = (event) => {
      debugLog('CLOSE', '连接关闭', { code: event.code, reason: event.reason });
      updateConnectionStatus(false);
      ws = null;
      partnerCharacter = null;
      updatePartnerCharacterDisplay();
    };
  } catch (error) {
    debugLog('ERROR', '创建 WebSocket 失败', error);
    toastr.error('连接失败: ' + error.message, 'Dual Tavern Bridge');
  }
}

function disconnectFromServer() {
  if (ws) {
    ws.close();
    ws = null;
    currentRoomId = null;
    partnerCharacter = null;
    updateConnectionStatus(false);
    updatePartnerCharacterDisplay();
    toastr.info('已断开连接', 'Dual Tavern Bridge');
  }
}

// ===== 服务器消息处理 =====
function handleServerMessage(message) {
  const { type, payload } = message;

  debugLog('HANDLE', `处理消息类型: ${type}`, payload);

  switch (type) {
    case 'room_created':
      debugLog('ROOM', '房间创建成功', payload);
      currentRoomId = payload.roomId;
      $('#dtb_room_code_display').text(currentRoomId);
      $('#dtb_room_code_input').val(currentRoomId);
      toastr.success(`房间创建成功: ${currentRoomId}`, 'Dual Tavern Bridge');
      syncCurrentCharacter();
      showRoomInfo();
      updateMainUIRoomState(true);
      updateChatUI(); // 添加这行
      break;

    case 'room_joined':
      debugLog('ROOM', '加入房间成功', payload);
      currentRoomId = payload.roomId;
      $('#dtb_room_code_display').text(currentRoomId);
      toastr.success('成功加入房间', 'Dual Tavern Bridge');
      syncCurrentCharacter();
      showRoomInfo();
      updateMainUIRoomState(true);
      updateChatUI(); // 添加这行
      break;

    case 'partner_joined':
      debugLog('ROOM', '对方加入房间', payload);
      partnerUserId = payload.partnerId;
      toastr.info('对方已加入房间', 'Dual Tavern Bridge');
      if (!mainUIVisible) {
        $('#dtb_notification_badge').show();
      }
      updateChatUI(); // 添加这行
      break;

    case 'partner_left':
      debugLog('ROOM', '对方离开房间', payload);
      partnerUserId = null;
      partnerCharacter = null;
      updatePartnerCharacterDisplay();
      toastr.warning('对方已离开房间', 'Dual Tavern Bridge');
      updateChatUI(); // 添加这行
      break;

    case 'character_synced':
      debugLog('CHARACTER', '角色同步', payload);
      if (payload.ownerId !== (ws ? ws.id : null)) {
        partnerCharacter = payload.characterData;
        updatePartnerCharacterDisplay();
        updatePartnerChatCharacter(); // 添加这行
        console.log('📥 对方角色已同步:', partnerCharacter.name);
      }
      break;


    case 'waiting_for_partner':
      debugLog('MESSAGE', '等待对方回复');
      isWaitingForPartner = true;
      showWaitingIndicator();
      break;

    case 'generate_response':
      debugLog('MESSAGE', '触发 AI 生成', payload);
      handleDualGeneration(payload);
      break;

    case 'partner_message':
      debugLog('MESSAGE', '收到对方消息', payload);
      handlePartnerMessage(payload);
      break;

    case 'error':
      debugLog('ERROR', '服务器错误', payload);
      toastr.error(payload.message, 'Dual Tavern Bridge');
      break;

    default:
      debugLog('WARN', '未知消息类型', { type, payload });
  }
}

// ===== 角色卡同步（仅文本，不传递图片）=====
function syncCurrentCharacter() {
  const context = SillyTavern.getContext();
  const { characters, characterId } = context;

  if (characterId === undefined) {
    console.warn('没有选中的角色');
    return;
  }

  const character = characters[characterId];

  const characterData = {
    name: character.name,
    description: character.data?.description || character.description || '',
    personality: character.data?.personality || character.personality || '',
    scenario: character.data?.scenario || character.scenario || '',
    first_mes: character.data?.first_mes || character.first_mes || '',
    mes_example: character.data?.mes_example || character.mes_example || ''
  };

  ws.send(JSON.stringify({
    type: 'sync_character',
    payload: {
      characterId,
      characterData
    }
  }));

  console.log('📤 角色卡已同步（仅文本）:', characterData.name);
  updateMainUIMyCharacter();
}

eventSource.on(event_types.MESSAGE_SENT, async (messageId) => {
  const settings = loadSettings();

  if (!settings.enabled || !ws || ws.readyState !== WebSocket.OPEN || !currentRoomId) {
    return;
  }

  const context = SillyTavern.getContext();
  const { chat } = context;

  const lastMessage = chat[chat.length - 1];

  if (!lastMessage || !lastMessage.is_user) {
    return;
  }

  const userMessage = lastMessage.mes;
  pendingMessage = userMessage;

  $('#dtb_my_message_preview').text(userMessage);

  if (settings.rolePlayMode && partnerCharacter) {
    handleRolePlayMessage(userMessage);
  } else {
    ws.send(JSON.stringify({
      type: 'send_message',
      payload: {
        message: userMessage,
        characterId: context.characterId
      }
    }));

    console.log('📤 消息已发送到中转服务器（协作模式）');
  }

  chat.pop();
  await context.saveChat();
  await eventSource.emit(event_types.CHAT_CHANGED, context.getCurrentChatId());
});

// ===== 角色扮演模式处理 =====
function handleRolePlayMessage(message) {
  const userPersona = getUserPersona();

  // 角色扮演模式提示词格式
  // [{角色接下来的行为倾向为:{扮演角色的用户的输入}}]
  const formattedMessage = `[{Character tendency: ${message}}]`;

  ws.send(JSON.stringify({
    type: 'roleplay_message',
    payload: {
      message: formattedMessage, // 发送格式化后的消息
      rawMessage: message, // 保留原始消息用于显示
      characterName: partnerCharacter.name,
      isRoleResponse: true,
      userPersona
    }
  }));

  console.log('🎭 角色扮演消息已发送');
  addMessageToChat(partnerCharacter.name, message, false); // 本地显示原始消息
}

// ===== 接收对方消息 =====
let partnerPersona = null; // 存储对方人设

async function handlePartnerMessage(payload) {
  const { message, characterName, isRoleResponse, userPersona } = payload;

  if (userPersona) {
    partnerPersona = userPersona;
  }

  // 添加到聊天 UI
  addChatMessage(characterName || (userPersona ? userPersona.name : '对方'), message, false);

  if (isRoleResponse) {
    await addMessageToChat(characterName, message, false);
    toastr.info(`${characterName} 回复了`, 'Dual Tavern Bridge');
  } else {
    await addMessageToChat('Partner', message, true);
  }

  $('#dtb_partner_message_preview').text(message);
}

// ===== 双人消息生成 =====
async function handleDualGeneration(payload) {
  const { userA, userB } = payload;
  const context = SillyTavern.getContext();
  const { generateRaw, characters, characterId } = context;
  const character = characters[characterId];

  hideWaitingIndicator();
  isWaitingForPartner = false;

  const systemPrompt = `You are ${character.name}. ${character.data?.description || character.description || ''}

Character Personality: ${character.data?.personality || character.personality || ''}
Scenario: ${character.data?.scenario || character.scenario || ''}`;

  // 构建新的提示词格式
  const userAPrompt = `[{${userA.persona?.name || 'User'} Persona: ${userA.persona?.description || ''}] {${userA.persona?.name || 'User'} Input: ${userA.message}}`;
  const userBPrompt = `[{${userB.persona?.name || 'Partner'} Persona: ${userB.persona?.description || ''}] {${userB.persona?.name || 'Partner'} Input: ${userB.message}}`;

  const prompt = `${userAPrompt}\n${userBPrompt}\n\nBased on the above inputs, generate a response as ${character.name}.`;

  try {
    console.log('🤖 开始生成 AI 回复...');

    const result = await generateRaw({
      systemPrompt,
      prompt,
      prefill: ''
    });

    await addMessageToChat(character.name, result, false, {
      dual_tavern: {
        userA: userA.message,
        userB: userB.message
      }
    });

    console.log('✅ AI 回复已生成');
    toastr.success('AI 回复已生成', 'Dual Tavern Bridge');
    addChatMessage(character.name, result, false);
  } catch (error) {
    console.error('生成失败:', error);
    toastr.error('AI 生成失败', 'Dual Tavern Bridge');
  }
}

// ===== 添加消息到聊天 =====
async function addMessageToChat(name, message, isUser, extra = {}) {
  const context = SillyTavern.getContext();

  const messageData = {
    name: name,
    is_user: isUser,
    is_system: false,
    send_date: Date.now(),
    mes: message,
    extra: extra
  };

  context.chat.push(messageData);
  await context.saveChat();
  await eventSource.emit(event_types.MESSAGE_RECEIVED, messageData);
}

// ===== UI 更新函数 =====
function updateConnectionStatus(connected) {
  const statusDot = $('#dtb_status_dot');
  const statusText = $('#dtb_status_text');

  if (connected) {
    statusDot.addClass('connected');
    statusText.text('已连接');
    $('#dtb_connect_btn').text('断开连接').removeClass('primary').addClass('danger');
  } else {
    statusDot.removeClass('connected');
    statusText.text('未连接');
    $('#dtb_connect_btn').text('连接').removeClass('danger').addClass('primary');
  }

  updateMainUIStatus();
}

function updatePartnerCharacterDisplay() {
  const container = $('#dtb_partner_character');

  if (!partnerCharacter) {
    container.html(`
      <div class="dtb-hint">
        <span class="dtb-hint-icon">ℹ️</span>
        等待对方加入并同步角色...
      </div>
    `);
  } else {
    container.html(`
      <div class="dtb-character-display">
        <div class="dtb-character-avatar-large">🎭</div>
        <div class="dtb-character-info">
          <div class="dtb-character-name">${partnerCharacter.name}</div>
          <div class="dtb-character-desc">${partnerCharacter.description || '暂无描述'}</div>
          <span class="dtb-character-role">对方角色</span>
        </div>
      </div>
    `);
  }

  updateMainUIPartnerCharacter();
}

function showWaitingIndicator() {
  $('#dtb_waiting_indicator').slideDown(200);
}

function hideWaitingIndicator() {
  $('#dtb_waiting_indicator').slideUp(200);
}

function showRoomInfo() {
  $('#dtb_room_info').slideDown(200);
  $('#dtb_create_join_section').slideUp(200);
}

function hideRoomInfo() {
  $('#dtb_room_info').slideUp(200);
  $('#dtb_create_join_section').slideDown(200);
}

// ===== 主 UI 覆盖层 =====
function createMainUI() {
  // 检查主页容器是否存在
  const mainContainer = $('#sheld');
  if (!mainContainer.length) {
    console.error('找不到 SillyTavern 主容器');
    return;
  }

  const mainUIHtml = `
    <!-- 快速操作按钮 -->
    <div class="dtb-quick-actions" id="dtb_quick_actions">
      <button class="dtb-fab primary" id="dtb_toggle_chat_ui" title="打开 Dual Tavern Bridge">
        🎭
        <span class="dtb-fab-badge" id="dtb_notification_badge" style="display: none;">!</span>
      </button>
    </div>

    <!-- 聊天覆盖层 -->
    <div class="dtb-chat-overlay" id="dtb_chat_overlay" style="display: none;">
      <!-- 头部 -->
      <div class="dtb-chat-header" id="dtb_chat_header_drag">
        <div class="dtb-chat-header-left">
          <span class="dtb-chat-status-indicator" id="dtb_chat_status_dot"></span>
          <div>
            <span class="dtb-chat-title">Dual Tavern Bridge</span>
            <span class="dtb-chat-subtitle" id="dtb_chat_room_info">未连接</span>
          </div>
        </div>
        <div class="dtb-chat-header-actions">
          <button class="dtb-icon-button" id="dtb_chat_settings" title="设置">⚙️</button>
          <button class="dtb-icon-button" id="dtb_chat_minimize" title="最小化">➖</button>
          <button class="dtb-icon-button close" id="dtb_chat_close" title="关闭">✕</button>
        </div>
      </div>

      <!-- 主体 -->
      <div class="dtb-chat-body">
        <!-- 左侧：我的角色 -->
        <div class="dtb-chat-left">
          <div class="dtb-section">
            <div class="dtb-section-title">我的角色</div>
            <div id="dtb_my_char_display">
              <div class="dtb-empty-state">
                <div class="dtb-empty-icon">👤</div>
                <div class="dtb-empty-text">未选择角色</div>
              </div>
            </div>
            <button id="dtb_update_my_char_chat" class="dtb-button primary" style="width: calc(100% - 24px); margin: 0 12px 12px;">
              🔄 更新角色信息
            </button>
          </div>
        </div>

        <!-- 中间：聊天区域 -->
        <div class="dtb-chat-center">
          <div class="dtb-chat-messages" id="dtb_chat_messages">
            <div class="dtb-empty-state">
              <div class="dtb-empty-icon">💬</div>
              <div class="dtb-empty-text">开始对话</div>
              <div class="dtb-empty-hint">连接服务器并加入房间后开始聊天</div>
            </div>
          </div>
          
          <!-- 输入区域 -->
          <div class="dtb-chat-input-area">
            <textarea id="dtb_chat_input" class="dtb-chat-input" placeholder="输入消息..." rows="1"></textarea>
            <button id="dtb_chat_send" class="dtb-chat-send-btn" disabled>✈️</button>
          </div>
        </div>

        <!-- 右侧：对方角色 -->
        <div class="dtb-chat-right">
          <div class="dtb-section">
            <div class="dtb-section-title">对方角色</div>
            <div id="dtb_partner_char_display">
              <div class="dtb-empty-state">
                <div class="dtb-empty-icon">👥</div>
                <div class="dtb-empty-text">等待对方</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // 插入到 body（因为是固定定位的覆盖层）
  $('body').append(mainUIHtml);

  bindChatUIEvents();
  makeDraggable();

  console.log('✅ Dual Tavern Bridge 聊天 UI 已创建');
}



function bindChatUIEvents() {
  // 打开/关闭聊天 UI
  $('#dtb_toggle_chat_ui').on('click', () => {
    $('#dtb_chat_overlay').toggleClass('active');
    if ($('#dtb_chat_overlay').hasClass('active')) {
      updateChatUI();
      $('#dtb_notification_badge').hide();
    }
  });

  $('#dtb_chat_close').on('click', () => {
    $('#dtb_chat_overlay').removeClass('active');
  });

  // 最小化/还原
  $('#dtb_chat_minimize').on('click', () => {
    $('#dtb_chat_overlay').toggleClass('minimized');
    isChatUIMinimized = !isChatUIMinimized;
  });

  // 打开设置面板
  $('#dtb_chat_settings').on('click', () => {
    $('#dtb_chat_overlay').removeClass('active');
    // 打开 ST 的扩展设置
    $('#extensions_settings').click();
  });

  // 连接（从设置面板同步）
  // 创建房间
  $('#dtb_chat_create_room').on('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先在设置中连接服务器', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'create_room', payload: {} }));
  });

  // 加入房间
  $('#dtb_chat_join_room').on('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先在设置中连接服务器', 'Dual Tavern Bridge');
      return;
    }
    const roomId = $('#dtb_chat_room_input').val().trim().toUpperCase();
    if (!roomId || roomId.length !== 6) {
      toastr.warning('请输入 6 位房间码', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
  });

  // 离开房间
  $('#dtb_chat_leave_room').on('click', () => {
    if (currentRoomId && ws) {
      ws.send(JSON.stringify({ type: 'leave_room', payload: { roomId: currentRoomId } }));
      currentRoomId = null;
      partnerCharacter = null;
      $('#dtb_chat_room_code_display').hide();
      updateChatUI();
    }
  });

  // 更新我的角色（聊天 UI 中的按钮）
  $('#dtb_update_my_char_chat').on('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先在设置中连接服务器', 'Dual Tavern Bridge');
      $('#dtb_chat_overlay').removeClass('active');
      // 打开设置面板
      setTimeout(() => {
        $('#extensions_settings').click();
      }, 300);
      return;
    }
    if (!currentRoomId) {
      toastr.warning('请先加入房间', 'Dual Tavern Bridge');
      return;
    }
    syncCurrentCharacter();
    toastr.success('角色信息已更新并发送给对方', 'Dual Tavern Bridge');
  });

  // 发送消息
  $('#dtb_chat_send').on('click', sendChatMessage);

  $('#dtb_chat_input').on('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // 输入框自动调整高度
  $('#dtb_chat_input').on('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // 房间码输入自动大写
  $('#dtb_chat_room_input').on('input', function () {
    $(this).val($(this).val().toUpperCase());
  });
}

// 发送聊天消息
function sendChatMessage() {
  const input = $('#dtb_chat_input');
  const message = input.val().trim();

  if (!message) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toastr.warning('未连接到服务器', 'Dual Tavern Bridge');
    return;
  }
  if (!currentRoomId) {
    toastr.warning('未加入房间', 'Dual Tavern Bridge');
    return;
  }

  const settings = loadSettings();

  // 添加到本地消息列表
  addChatMessage('我', message, true);

  // 发送到服务器
  const userPersona = getUserPersona();

  if (settings.rolePlayMode && partnerCharacter) {
    handleRolePlayMessage(message);
  } else {
    ws.send(JSON.stringify({
      type: 'send_message',
      payload: {
        message,
        characterId: SillyTavern.getContext().characterId,
        userPersona
      }
    }));
  }

  input.val('').css('height', 'auto');
}

// 添加消息到聊天UI
function addChatMessage(name, text, isUser) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const avatar = isUser ? '👤' : '🎭';

  const messageHtml = `
    <div class="dtb-message-item ${isUser ? 'user' : ''}">
      <div class="dtb-message-avatar">${avatar}</div>
      <div class="dtb-message-content">
        <div class="dtb-message-header">
          <span class="dtb-message-name">${name}</span>
          <span class="dtb-message-time">${time}</span>
        </div>
        <div class="dtb-message-text">${text}</div>
      </div>
    </div>
  `;

  const container = $('#dtb_chat_messages');

  // 移除空状态
  container.find('.dtb-empty-state').remove();

  container.append(messageHtml);
  container.scrollTop(container[0].scrollHeight);

  chatMessages.push({ name, text, isUser, time });
}

// 更新聊天 UI
function updateChatUI() {
  // 更新连接状态（两个地方）
  const statusDot = $('#dtb_chat_status_dot');
  const connStatus = $('#dtb_chat_conn_status');
  const roomInfo = $('#dtb_chat_room_info');
  const sendBtn = $('#dtb_chat_send');

  if (ws && ws.readyState === WebSocket.OPEN) {
    statusDot.addClass('connected');
    connStatus.removeClass('disconnected').addClass('connected').html('<span class="dtb-status-dot"></span>已连接');

    if (currentRoomId) {
      roomInfo.text(`房间: ${currentRoomId}`);
      sendBtn.prop('disabled', false);
      $('#dtb_chat_room_code_display').show();
      $('#dtb_chat_current_room').text(currentRoomId);
    } else {
      roomInfo.text('已连接 - 未加入房间');
      sendBtn.prop('disabled', true);
      $('#dtb_chat_room_code_display').hide();
    }
  } else {
    statusDot.removeClass('connected');
    connStatus.removeClass('connected').addClass('disconnected').html('<span class="dtb-status-dot"></span>未连接');
    roomInfo.text('未连接');
    sendBtn.prop('disabled', true);
    $('#dtb_chat_room_code_display').hide();
  }

  // 更新我的角色
  updateMyChatCharacter();

  // 更新对方角色
  updatePartnerChatCharacter();
}


// 更新我的角色显示
function updateMyChatCharacter() {
  const container = $('#dtb_my_char_display');
  const context = SillyTavern.getContext();
  const { characters, characterId } = context;

  if (characterId === undefined || !characters[characterId]) {
    container.html(`
      <div class="dtb-empty-state">
        <div class="dtb-empty-icon">👤</div>
        <div class="dtb-empty-text">未选择角色</div>
      </div>
    `);
    return;
  }

  const character = characters[characterId];
  container.html(`
    <div class="dtb-char-card-simple">
      <div class="dtb-char-header-simple">
        <div class="dtb-char-avatar-simple">👤</div>
        <div class="dtb-char-name-simple">${character.name}</div>
      </div>
      <div class="dtb-char-desc-simple">${character.data?.description || character.description || '暂无描述'}</div>
    </div>
  `);
}

// 更新对方角色显示
function updatePartnerChatCharacter() {
  const container = $('#dtb_partner_char_display');

  if (!partnerCharacter) {
    container.html(`
      <div class="dtb-empty-state">
        <div class="dtb-empty-icon">👥</div>
        <div class="dtb-empty-text">等待对方</div>
      </div>
    `);
    return;
  }

  container.html(`
    <div class="dtb-char-card-simple">
      <div class="dtb-char-header-simple">
        <div class="dtb-char-avatar-simple">🎭</div>
        <div class="dtb-char-name-simple">${partnerCharacter.name}</div>
      </div>
      <div class="dtb-char-desc-simple">${partnerCharacter.description || '暂无描述'}</div>
    </div>
  `);
}

// 使头部可拖动
// 使头部可拖动
function makeDraggable() {
  const overlay = document.getElementById('dtb_chat_overlay');
  const header = document.getElementById('dtb_chat_header_drag');
  let isDragging = false;
  let currentX, currentY, initialX, initialY;
  let xOffset = 0;
  let yOffset = 0;

  header.addEventListener('mousedown', (e) => {
    // 允许在任何状态下拖动
    // 计算初始偏移量，考虑到 transform 的影响
    const rect = overlay.getBoundingClientRect();

    // 如果是第一次拖动，移除 transform 并设置具体的 left/top
    if (overlay.style.transform && overlay.style.transform.includes('translate')) {
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.transform = 'none';
      overlay.style.bottom = 'auto';
      overlay.style.right = 'auto';
    }

    initialX = e.clientX - overlay.offsetLeft;
    initialY = e.clientY - overlay.offsetTop;
    isDragging = true;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      // 边界检查（可选，防止拖出屏幕）
      // const maxX = window.innerWidth - overlay.offsetWidth;
      // const maxY = window.innerHeight - overlay.offsetHeight;
      // currentX = Math.min(Math.max(0, currentX), maxX);
      // currentY = Math.min(Math.max(0, currentY), maxY);

      overlay.style.left = currentX + 'px';
      overlay.style.top = currentY + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    header.style.cursor = 'grab';
  });
}

function toggleMainUI() {
  mainUIVisible ? hideMainUI() : showMainUI();
}

function showMainUI() {
  $('#dtb_main_overlay').addClass('active');
  mainUIVisible = true;

  updateMainUIStatus();
  updateMainUIMyCharacter();
  updateMainUIPartnerCharacter();
  updateMainUIRoomState(!!currentRoomId);

  $('#dtb_notification_badge').hide();
}

function hideMainUI() {
  $('#dtb_main_overlay').removeClass('active');
  mainUIVisible = false;
}

function updateMainUIStatus() {
  const badge = $('#dtb_main_status');
  const button = $('#dtb_main_connect');

  if (ws && ws.readyState === WebSocket.OPEN) {
    badge.removeClass('disconnected').addClass('connected').html('<span class="dtb-status-dot"></span>已连接');
    button.text('断开连接').removeClass('primary').addClass('danger');
  } else {
    badge.removeClass('connected').addClass('disconnected').html('<span class="dtb-status-dot"></span>未连接');
    button.text('连接').removeClass('danger').addClass('primary');
  }

  const settings = loadSettings();
  $('#dtb_main_server_url').val(settings.serverUrl);
}

function updateMainUIRoomState(inRoom) {
  if (inRoom) {
    $('#dtb_main_no_room').hide();
    $('#dtb_main_in_room').show();
    $('#dtb_main_room_code').text(currentRoomId);
  } else {
    $('#dtb_main_no_room').show();
    $('#dtb_main_in_room').hide();
    $('#dtb_main_room_input').val('');
  }
}

function updateMainUIMyCharacter() {
  const container = $('#dtb_main_my_character');
  const context = SillyTavern.getContext();
  const { characters, characterId } = context;

  if (characterId === undefined || !characters[characterId]) {
    container.html(`
      <div class="dtb-empty-state">
        <div class="dtb-empty-icon">👤</div>
        <div class="dtb-empty-text">未选择角色</div>
      </div>
    `);
    return;
  }

  const character = characters[characterId];
  const charData = {
    name: character.name,
    description: character.data?.description || character.description || '',
    personality: character.data?.personality || character.personality || ''
  };

  container.html(`
    <div class="dtb-character-card-large">
      <div class="dtb-character-header">
        <div class="dtb-character-avatar-large">👤</div>
        <div class="dtb-character-header-info">
          <div class="dtb-character-name-large">${charData.name}</div>
          <div class="dtb-character-label">
            <span>📝</span>
            <span>我的角色</span>
          </div>
        </div>
      </div>
      <div class="dtb-character-details">
        <div class="dtb-detail-item">
          <div class="dtb-detail-label">描述</div>
          <div class="dtb-detail-content">${charData.description || ''}</div>
        </div>
        <div class="dtb-detail-item">
          <div class="dtb-detail-label">性格</div>
          <div class="dtb-detail-content">${charData.personality || ''}</div>
        </div>
      </div>
    </div>
  `);
}

function updateMainUIPartnerCharacter() {
  const container = $('#dtb_main_partner_character');

  if (!partnerCharacter) {
    container.html(`
      <div class="dtb-empty-state">
        <div class="dtb-empty-icon">👥</div>
        <div class="dtb-empty-text">等待对方加入</div>
        <div class="dtb-empty-hint">对方加入房间后，角色信息会显示在这里</div>
      </div>
    `);
    return;
  }

  container.html(`
    <div class="dtb-character-card-large">
      <div class="dtb-character-header">
        <div class="dtb-character-avatar-large">🎭</div>
        <div class="dtb-character-header-info">
          <div class="dtb-character-name-large">${partnerCharacter.name}</div>
          <div class="dtb-character-label">
            <span>👥</span>
            <span>对方角色</span>
          </div>
        </div>
      </div>
      <div class="dtb-character-details">
        <div class="dtb-detail-item">
          <div class="dtb-detail-label">描述</div>
          <div class="dtb-detail-content">${partnerCharacter.description || ''}</div>
        </div>
        <div class="dtb-detail-item">
          <div class="dtb-detail-label">性格</div>
          <div class="dtb-detail-content">${partnerCharacter.personality || ''}</div>
        </div>
        <div class="dtb-detail-item">
          <div class="dtb-detail-label">场景</div>
          <div class="dtb-detail-content">${partnerCharacter.scenario || ''}</div>
        </div>
      </div>
    </div>
  `);

  if (!mainUIVisible) {
    $('#dtb_notification_badge').show();
  }
}

// ===== 辅助函数 =====
function fallbackCopy(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    document.execCommand('copy');
    toastr.success('房间码已复制', 'Dual Tavern Bridge');
  } catch (err) {
    console.error('复制失败:', err);
    toastr.error('复制失败，请手动复制', 'Dual Tavern Bridge');
  }

  document.body.removeChild(textArea);
}


jQuery(async () => {
  // 创建设置面板
  const settingsHtml = `
    <div class="dual-tavern-bridge-settings-container">
      <div class="dtb-main-settings-header" id="dtb_main_settings_toggle">
        <div class="dtb-main-settings-title">
          <span class="dtb-main-icon">🎭</span>
          <span>Dual Tavern Bridge 插件设置</span>
        </div>
        <span class="dtb-arrow-icon">▼</span>
      </div>
      
      <div class="dtb-main-settings-content collapsed" id="dtb_main_settings_body">
        <div class="dual-tavern-bridge-settings">
          
          <!-- 连接设置面板 -->
          <div class="dtb-panel">
            <div class="dtb-panel-header" data-panel="dtb_connection">
              <div class="dtb-panel-title">
                <span class="dtb-panel-icon" id="dtb_connection_icon">▼</span>
                <span>🌐 连接设置</span>
              </div>
              <div class="dtb-status-indicator">
                <span class="dtb-status-dot" id="dtb_status_dot"></span>
                <span id="dtb_status_text">未连接</span>
              </div>
            </div>
            
            <div class="dtb-panel-content" id="dtb_connection_content">
              <div class="dtb-checkbox-wrapper">
                <input type="checkbox" id="dtb_enabled" />
                <label class="dtb-checkbox-label" for="dtb_enabled">启用双人协作模式</label>
              </div>
              
              <div class="dtb-form-group">
                <label class="dtb-form-label">服务器地址</label>
                <div class="dtb-form-row">
                  <input type="text" id="dtb_server_url" class="dtb-input" placeholder="wss://your-tunnel.trycloudflare.com" />
                  <button id="dtb_connect_btn" class="dtb-button primary">连接</button>
                </div>
              </div>
              
              <div class="dtb-hint">
                <span class="dtb-hint-icon">💡</span>
                使用 cloudflared 创建隧道后，将 https:// 改为 wss:// 填入上方
              </div>
            </div>
          </div>

          <!-- 房间管理面板 -->
          <div class="dtb-panel">
            <div class="dtb-panel-header" data-panel="dtb_room">
              <div class="dtb-panel-title">
                <span class="dtb-panel-icon" id="dtb_room_icon">▼</span>
                <span>🏠 房间管理</span>
              </div>
            </div>
            
            <div class="dtb-panel-content collapsed" id="dtb_room_content">
              <div id="dtb_create_join_section">
                <div class="dtb-button-group">
                  <button id="dtb_create_room" class="dtb-button primary" style="flex: 1;">创建房间</button>
                </div>
                
                <div class="dtb-divider"></div>
                
                <div class="dtb-form-group">
                  <label class="dtb-form-label">加入现有房间</label>
                  <div class="dtb-form-row">
                    <input type="text" id="dtb_room_code_input" class="dtb-input" placeholder="输入 6 位房间码" maxlength="6" />
                    <button id="dtb_join_room" class="dtb-button">加入</button>
                  </div>
                </div>
              </div>
              
              <div id="dtb_room_info" style="display: none;">
                <div class="dtb-room-card">
                  <label class="dtb-form-label">当前房间码</label>
                  <div class="dtb-room-code-display">
                    <span id="dtb_room_code_display">------</span>
                    <button id="dtb_copy_room_code" class="dtb-button dtb-copy-button">复制</button>
                  </div>
                </div>
                
                <button id="dtb_leave_room" class="dtb-button danger" style="width: 100%;">离开房间</button>
              </div>
            </div>
          </div>

          <!-- 对方角色信息面板 -->
          <div class="dtb-panel">
            <div class="dtb-panel-header" data-panel="dtb_partner">
              <div class="dtb-panel-title">
                <span class="dtb-panel-icon" id="dtb_partner_icon">▼</span>
                <span>👥 对方角色信息</span>
              </div>
            </div>
            
            <div class="dtb-panel-content collapsed" id="dtb_partner_content">
              <div id="dtb_partner_character">
                <div class="dtb-hint">
                  <span class="dtb-hint-icon">ℹ️</span>
                  等待对方加入并同步角色...
                </div>
              </div>
              
              <button id="dtb_update_my_character" class="dtb-button primary" style="width: 100%; margin-top: 10px;">
                🔄 更新我的角色信息
              </button>
            </div>
          </div>

          <!-- 协作模式设置面板 -->
          <div class="dtb-panel">
            <div class="dtb-panel-header" data-panel="dtb_mode">
              <div class="dtb-panel-title">
                <span class="dtb-panel-icon" id="dtb_mode_icon">▼</span>
                <span>🎭 协作模式</span>
              </div>
            </div>
            
            <div class="dtb-panel-content collapsed" id="dtb_mode_content">
              <div class="dtb-checkbox-wrapper">
                <input type="checkbox" id="dtb_roleplay_mode" />
                <label class="dtb-checkbox-label" for="dtb_roleplay_mode">启用角色扮演模式</label>
              </div>
              
              <div class="dtb-hint">
                <span class="dtb-hint-icon">ℹ️</span>
                <strong>普通模式：</strong>双方消息组合后生成 AI 回复<br>
                <strong>角色扮演模式：</strong>你扮演对方的角色，直接回复对方
              </div>
              
              <div class="dtb-divider"></div>
              
              <div class="dtb-form-group">
                <label class="dtb-form-label">我的消息预览</label>
                <div class="dtb-message-preview" id="dtb_my_message_preview">暂无消息</div>
              </div>
              
              <div class="dtb-form-group">
                <label class="dtb-form-label">对方消息预览</label>
                <div class="dtb-message-preview" id="dtb_partner_message_preview">暂无消息</div>
              </div>
            </div>
          </div>

          <div id="dtb_waiting_indicator" class="dtb-waiting-indicator" style="display: none;">
            <div class="dtb-waiting-spinner"></div>
            <span class="dtb-waiting-text">等待对方回复...</span>
          </div>

        </div>
      </div>
    </div>
  `;

  // 插入设置面板
  // 尝试插入到扩展设置区域
  const extensionSettingsContainer = $('#extensions_settings');
  if (extensionSettingsContainer.length) {
    // 检查是否已经存在
    if ($('#dual-tavern-bridge-settings-container').length === 0) {
      extensionSettingsContainer.append(settingsHtml);
    }
  } else {
    // 如果找不到扩展设置容器，回退到 body (虽然不太可能)
    $('body').append(settingsHtml);
  }

  // 绑定设置面板事件
  $('#dtb_main_settings_toggle').on('click', () => {
    $('#dtb_main_settings_body').toggleClass('collapsed');
    const icon = $('#dtb_main_settings_toggle .dtb-arrow-icon');
    if ($('#dtb_main_settings_body').hasClass('collapsed')) {
      icon.text('▼');
    } else {
      icon.text('▲');
    }
  });

  $('.dtb-panel-header').on('click', function () {
    const panelId = $(this).data('panel');
    const content = $(`#${panelId}_content`);
    const icon = $(this).find('.dtb-panel-icon');

    content.toggleClass('collapsed');
    if (content.hasClass('collapsed')) {
      icon.text('▼');
    } else {
      icon.text('▲');
    }
  });

  // 绑定设置输入事件
  $('#dtb_enabled').on('change', function () {
    const settings = loadSettings();
    settings.enabled = $(this).is(':checked');
    saveSettings();
  });

  $('#dtb_server_url').on('change', function () {
    const settings = loadSettings();
    settings.serverUrl = $(this).val();
    saveSettings();
  });

  $('#dtb_connect_btn').on('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      disconnectFromServer();
    } else {
      connectToServer();
    }
  });

  $('#dtb_create_room').on('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接服务器', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'create_room', payload: {} }));
  });

  $('#dtb_join_room').on('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接服务器', 'Dual Tavern Bridge');
      return;
    }
    const roomId = $('#dtb_room_code_input').val().trim().toUpperCase();
    if (!roomId || roomId.length !== 6) {
      toastr.warning('请输入 6 位房间码', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
  });

  $('#dtb_leave_room').on('click', () => {
    if (currentRoomId && ws) {
      ws.send(JSON.stringify({ type: 'leave_room', payload: { roomId: currentRoomId } }));
      currentRoomId = null;
      partnerCharacter = null;
      $('#dtb_room_info').hide();
      $('#dtb_create_join_section').show();
      updateChatUI();
    }
  });

  $('#dtb_copy_room_code').on('click', () => {
    const code = $('#dtb_room_code_display').text();
    fallbackCopy(code);
  });

  $('#dtb_update_my_character').on('click', () => {
    syncCurrentCharacter();
    toastr.success('角色信息已更新', 'Dual Tavern Bridge');
  });

  $('#dtb_roleplay_mode').on('change', function () {
    const settings = loadSettings();
    settings.rolePlayMode = $(this).is(':checked');
    saveSettings();
  });

  // 创建主 UI
  createMainUI();

  console.log('✅ Dual Tavern Bridge 插件已加载');
});

