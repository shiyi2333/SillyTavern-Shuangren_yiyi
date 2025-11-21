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
      break;

    case 'room_joined':
      debugLog('ROOM', '加入房间成功', payload);
      currentRoomId = payload.roomId;
      $('#dtb_room_code_display').text(currentRoomId);
      toastr.success('成功加入房间', 'Dual Tavern Bridge');
      syncCurrentCharacter();
      showRoomInfo();
      updateMainUIRoomState(true);
      break;

    case 'partner_joined':
      debugLog('ROOM', '对方加入房间', payload);
      partnerUserId = payload.partnerId;
      toastr.info('对方已加入房间', 'Dual Tavern Bridge');
      if (!mainUIVisible) {
        $('#dtb_notification_badge').show();
      }
      break;

    case 'partner_left':
      debugLog('ROOM', '对方离开房间', payload);
      partnerUserId = null;
      partnerCharacter = null;
      updatePartnerCharacterDisplay();
      toastr.warning('对方已离开房间', 'Dual Tavern Bridge');
      break;

    case 'character_synced':
      debugLog('CHARACTER', '角色同步', payload);
      if (payload.ownerId !== (ws ? ws.id : null)) {
        partnerCharacter = payload.characterData;
        updatePartnerCharacterDisplay();
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

// ===== 消息拦截和处理 =====
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
  ws.send(JSON.stringify({
    type: 'roleplay_message',
    payload: {
      message: message,
      characterName: partnerCharacter.name,
      isRoleResponse: true
    }
  }));

  console.log('🎭 角色扮演消息已发送');
  addMessageToChat(partnerCharacter.name, message, false);
}

// ===== 接收对方消息 =====
async function handlePartnerMessage(payload) {
  const { message, characterName, isRoleResponse } = payload;
  
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

  const prompt = `[Identity Instruction]: Respond as if you are ${userA.message}

[Response Direction]: ${userB.message}

Based on the identity instruction and response direction above, generate a response as ${character.name}. Stay in character and follow the response direction naturally.`;

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
  const mainUIHtml = `
    <!-- 快速操作按钮 -->
    <div class="dtb-quick-actions">
      <button class="dtb-fab primary" id="dtb_toggle_main_ui" title="打开 Dual Tavern Bridge">
        🎭
        <span class="dtb-fab-badge" id="dtb_notification_badge" style="display: none;">!</span>
      </button>
    </div>

    <!-- 主覆盖层 -->
    <div class="dtb-overlay" id="dtb_main_overlay">
      <div class="dtb-main-ui">
        <!-- 头部 -->
        <div class="dtb-main-header">
          <div class="dtb-main-title">
            <span class="dtb-main-title-icon">🎭</span>
            <span>Dual Tavern Bridge</span>
          </div>
          <div class="dtb-header-actions">
            <button class="dtb-icon-button" id="dtb_refresh_ui" title="刷新">
              🔄
            </button>
            <button class="dtb-icon-button close" id="dtb_close_main_ui" title="关闭">
              ✕
            </button>
          </div>
        </div>

        <!-- 主体 -->
        <div class="dtb-main-body">
          <!-- 左侧面板 -->
          <div class="dtb-left-panel">
            <!-- 连接状态 -->
            <div class="dtb-section">
              <div class="dtb-section-title">连接状态</div>
              <div class="dtb-connection-card">
                <div class="dtb-connection-status">
                  <span>服务器</span>
                  <span class="dtb-status-badge disconnected" id="dtb_main_status">
                    <span class="dtb-status-dot"></span>
                    未连接
                  </span>
                </div>
                <input type="text" id="dtb_main_server_url" class="dtb-input" placeholder="wss://..." />
                <button id="dtb_main_connect" class="dtb-button primary" style="width: 100%;">连接</button>
              </div>
            </div>

            <!-- 房间管理 -->
            <div class="dtb-section">
              <div class="dtb-section-title">房间管理</div>
              <div id="dtb_main_room_section">
                <!-- 未加入房间 -->
                <div id="dtb_main_no_room">
                  <button id="dtb_main_create_room" class="dtb-button primary" style="width: 100%; margin-bottom: 10px;">
                    创建房间
                  </button>
                  <div class="dtb-form-row">
                    <input type="text" id="dtb_main_room_input" class="dtb-input" placeholder="房间码" maxlength="6" />
                    <button id="dtb_main_join_room" class="dtb-button">加入</button>
                  </div>
                </div>

                <!-- 已加入房间 -->
                <div id="dtb_main_in_room" style="display: none;">
                  <div class="dtb-room-card-main">
                    <div class="dtb-room-code-large" id="dtb_main_room_code">------</div>
                    <button id="dtb_main_copy_code" class="dtb-button" style="width: 100%;">
                      📋 复制房间码
                    </button>
                    <button id="dtb_main_leave_room" class="dtb-button danger" style="width: 100%;">
                      离开房间
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 我的角色 -->
            <div class="dtb-section">
              <div class="dtb-section-title">我的角色</div>
              <div id="dtb_main_my_character">
                <div class="dtb-empty-state">
                  <div class="dtb-empty-icon">👤</div>
                  <div class="dtb-empty-text">未选择角色</div>
                </div>
              </div>
              <button id="dtb_update_character" class="dtb-button primary" style="width: 100%; margin-top: 10px;">
                🔄 更新角色信息
              </button>
            </div>
          </div>

          <!-- 右侧面板 -->
          <div class="dtb-right-panel">
            <div class="dtb-section-title">对方角色信息</div>
            <div id="dtb_main_partner_character">
              <div class="dtb-empty-state">
                <div class="dtb-empty-icon">👥</div>
                <div class="dtb-empty-text">等待对方加入</div>
                <div class="dtb-empty-hint">对方加入房间后，角色信息会显示在这里</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  $('body').append(mainUIHtml);
  bindMainUIEvents();
}

function bindMainUIEvents() {
  $('#dtb_toggle_main_ui').on('click', toggleMainUI);
  $('#dtb_close_main_ui').on('click', hideMainUI);
  
  $('#dtb_main_overlay').on('click', function(e) {
    if (e.target === this) hideMainUI();
  });

  $(document).on('keydown', function(e) {
    if (e.key === 'Escape' && mainUIVisible) hideMainUI();
  });

  $('#dtb_main_connect').on('click', function() {
    const url = $('#dtb_main_server_url').val().trim();
    if (url) {
      $('#dtb_server_url').val(url);
      const settings = loadSettings();
      settings.serverUrl = url;
      saveSettings();
      
      if (ws && ws.readyState === WebSocket.OPEN) {
        disconnectFromServer();
      } else {
        connectToServer();
      }
    }
  });

  $('#dtb_main_create_room').on('click', function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接到服务器', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'create_room', payload: {} }));
  });

  $('#dtb_main_join_room').on('click', function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接到服务器', 'Dual Tavern Bridge');
      return;
    }
    const roomId = $('#dtb_main_room_input').val().trim().toUpperCase();
    if (!roomId || roomId.length !== 6) {
      toastr.warning('请输入 6 位房间码', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
  });

  $('#dtb_main_copy_code').on('click', function() {
    const code = $('#dtb_main_room_code').text();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => {
        toastr.success('房间码已复制', 'Dual Tavern Bridge');
      });
    }
  });

  $('#dtb_main_leave_room').on('click', function() {
    if (currentRoomId && ws) {
      ws.send(JSON.stringify({ type: 'leave_room', payload: { roomId: currentRoomId } }));
      currentRoomId = null;
      partnerCharacter = null;
      updateMainUIRoomState(false);
      updateMainUIPartnerCharacter();
      hideRoomInfo();
    }
  });

  $('#dtb_update_character').on('click', function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接到服务器', 'Dual Tavern Bridge');
      return;
    }
    if (!currentRoomId) {
      toastr.warning('请先加入房间', 'Dual Tavern Bridge');
      return;
    }
    syncCurrentCharacter();
    toastr.success('角色信息已更新', 'Dual Tavern Bridge');
  });

  $('#dtb_refresh_ui').on('click', function() {
    updateMainUIStatus();
    updateMainUIMyCharacter();
    updateMainUIPartnerCharacter();
    toastr.info('UI 已刷新', 'Dual Tavern Bridge');
  });

  $('#dtb_main_room_input').on('input', function() {
    $(this).val($(this).val().toUpperCase());
  });

  $('#dtb_main_room_input').on('keypress', function(e) {
    if (e.which === 13) $('#dtb_main_join_room').click();
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

// ===== 初始化 =====
jQuery(async () => {
  // 创建设置面板
  const settingsHtml = `
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
        
        <div class="dtb-panel-content" id="dtb_room_content">
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
        
        <div class="dtb-panel-content" id="dtb_partner_content">
          <div id="dtb_partner_character">
            <div class="dtb-hint">
              <span class="dtb-hint-icon">ℹ️</span>
              等待对方加入并同步角色...
            </div>
          </div>
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
        
        <div class="dtb-panel-content" id="dtb_mode_content">
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
  `;

  $('#extensions_settings2').append(settingsHtml);

  // 加载设置
  const settings = loadSettings();
  $('#dtb_enabled').prop('checked', settings.enabled);
  $('#dtb_server_url').val(settings.serverUrl);
  $('#dtb_roleplay_mode').prop('checked', settings.rolePlayMode);
  isRolePlayMode = settings.rolePlayMode;

  // 初始化面板状态
  setTimeout(() => {
    $('.dtb-panel-content').each(function() {
      $(this).css('max-height', this.scrollHeight + 'px');
    });
  }, 100);

  // 折叠面板事件
  $('.dtb-panel-header').on('click', function(e) {
    e.preventDefault();
    const panelId = $(this).data('panel');
    const content = $(`#${panelId}_content`);
    const icon = $(`#${panelId}_icon`);
    
    if (content.hasClass('collapsed')) {
      content.removeClass('collapsed');
      content.css('max-height', content[0].scrollHeight + 'px');
      icon.removeClass('collapsed');
    } else {
      content.addClass('collapsed');
      content.css('max-height', '0');
      icon.addClass('collapsed');
    }
  });

  // 事件绑定
  $('#dtb_enabled').on('change', function() {
    settings.enabled = $(this).prop('checked');
    saveSettings();
    toastr.info(settings.enabled ? '双人协作模式已启用' : '双人协作模式已禁用', 'Dual Tavern Bridge');
  });

  $('#dtb_server_url').on('change', function() {
    settings.serverUrl = $(this).val().trim();
    saveSettings();
  });

  $('#dtb_roleplay_mode').on('change', function() {
    settings.rolePlayMode = $(this).prop('checked');
    isRolePlayMode = settings.rolePlayMode;
    saveSettings();
    toastr.info(settings.rolePlayMode ? '已切换到角色扮演模式' : '已切换到普通协作模式', 'Dual Tavern Bridge');
  });

  $('#dtb_connect_btn').on('click', function(e) {
    e.preventDefault();
    if (ws && ws.readyState === WebSocket.OPEN) {
      disconnectFromServer();
    } else {
      connectToServer();
    }
  });

  $('#dtb_create_room').on('click', function(e) {
    e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接到服务器', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'create_room', payload: {} }));
  });

  $('#dtb_join_room').on('click', function(e) {
    e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toastr.warning('请先连接到服务器', 'Dual Tavern Bridge');
      return;
    }
    const roomId = $('#dtb_room_code_input').val().trim().toUpperCase();
    if (!roomId || roomId.length !== 6) {
      toastr.warning('请输入 6 位房间码', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
  });

  $('#dtb_copy_room_code').on('click', function(e) {
    e.preventDefault();
    const roomCode = $('#dtb_room_code_display').text();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(roomCode).then(() => {
        toastr.success('房间码已复制', 'Dual Tavern Bridge');
      }).catch(() => fallbackCopy(roomCode));
    } else {
      fallbackCopy(roomCode);
    }
  });

  $('#dtb_leave_room').on('click', function(e) {
    e.preventDefault();
    if (!currentRoomId || !ws) {
      toastr.warning('当前未在任何房间中', 'Dual Tavern Bridge');
      return;
    }
    ws.send(JSON.stringify({ type: 'leave_room', payload: { roomId: currentRoomId } }));
    currentRoomId = null;
    partnerCharacter = null;
    partnerUserId = null;
    $('#dtb_room_code_display').text('------');
    $('#dtb_room_code_input').val('');
    hideRoomInfo();
    updatePartnerCharacterDisplay();
    toastr.info('已离开房间', 'Dual Tavern Bridge');
  });

  $('#dtb_room_code_input').on('input', function() {
    $(this).val($(this).val().toUpperCase());
  });

  $('#dtb_room_code_input').on('keypress', function(e) {
    if (e.which === 13) {
      e.preventDefault();
      $('#dtb_join_room').click();
    }
  });

  // 角色切换时自动同步
  eventSource.on(event_types.CHAT_CHANGED, () => {
    if (settings.enabled && settings.autoSync && ws && ws.readyState === WebSocket.OPEN && currentRoomId) {
      syncCurrentCharacter();
    }
  });

  // 创建主 UI
  createMainUI();
  
  console.log('✅ Dual Tavern Bridge 插件已加载');
});

