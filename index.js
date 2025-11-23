import {
  eventSource,
  event_types,
  saveSettingsDebounced,
  getContext,
} from '../../../../script.js';

// ===== 常量定义 =====
const EXTENSION_NAME = 'Dual Tavern Bridge';
const SETTINGS_KEY = 'dual_tavern_bridge_settings';
const DEFAULT_SETTINGS = {
  enabled: false,
  serverUrl: 'wss://your-tunnel.trycloudflare.com',
  rolePlayMode: false,
};

// ===== 工具类 =====
class Utils {
  static loadSettings() {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    return { ...DEFAULT_SETTINGS, ...settings };
  }

  static saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  static getUserPersona() {
    // 1. 尝试从 SillyTavern 的 userSettings 获取
    if (SillyTavern.userSettings) {
      return {
        name: SillyTavern.userSettings.user_name || 'User',
        description: SillyTavern.userSettings.user_description || '',
        avatar: SillyTavern.userSettings.user_avatar || null // 如果有的话
      };
    }

    // 2. 尝试从 DOM 获取 (回退方案)
    const nameInput = document.getElementById('user_name');
    const descInput = document.getElementById('user_description'); // 假设 ID
    if (nameInput) {
      return {
        name: nameInput.value || 'User',
        description: descInput ? descInput.value : ''
      };
    }

    // 3. 尝试从 Context 获取
    const context = SillyTavern.getContext();
    if (context.user) {
      return {
        name: context.user.name || 'User',
        description: context.user.description || ''
      };
    }

    return { name: 'User', description: '' };
  }

  static copyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      toastr.success('复制成功', EXTENSION_NAME);
    } catch (err) {
      console.error('复制失败:', err);
      toastr.error('复制失败', EXTENSION_NAME);
    }
    document.body.removeChild(textArea);
  }
}

// ===== 网络管理类 =====
class NetworkManager {
  constructor(bridge) {
    this.bridge = bridge;
    this.ws = null;
    this.retryCount = 0;
    this.maxRetries = 5;
  }

  connect() {
    const settings = Utils.loadSettings();
    if (!settings.serverUrl) {
      toastr.warning('请先配置服务器地址', EXTENSION_NAME);
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(settings.serverUrl);
      this.bindEvents();
    } catch (error) {
      console.error('连接错误:', error);
      toastr.error('连接失败，请检查地址', EXTENSION_NAME);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  bindEvents() {
    this.ws.onopen = () => {
      console.log('✅ 已连接到中转服务器');
      toastr.success('已连接到服务器', EXTENSION_NAME);
      this.retryCount = 0;
      this.bridge.updateConnectionStatus(true);

      // 如果有房间ID，尝试重新加入
      if (this.bridge.currentRoomId) {
        this.send('join_room', { roomId: this.bridge.currentRoomId });
      }
    };

    this.ws.onclose = () => {
      console.log('❌ 与服务器断开连接');
      this.bridge.updateConnectionStatus(false);
      this.ws = null;
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket 错误:', error);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        console.error('解析消息失败:', e);
      }
    };
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      toastr.warning('未连接到服务器', EXTENSION_NAME);
    }
  }

  handleMessage(data) {
    const { type, payload } = data;
    switch (type) {
      case 'room_created':
        this.bridge.handleRoomCreated(payload);
        break;
      case 'room_joined':
        this.bridge.handleRoomJoined(payload);
        break;
      case 'partner_joined':
        this.bridge.handlePartnerJoined(payload);
        break;
      case 'partner_left':
        this.bridge.handlePartnerLeft();
        break;
      case 'partner_message':
        this.bridge.handlePartnerMessage(payload);
        break;
      case 'dual_generation':
        this.bridge.handleDualGeneration(payload);
        break;
      case 'error':
        toastr.error(payload.message, EXTENSION_NAME);
        break;
    }
  }
}

// ===== 设置面板类 =====
class SettingsPanel {
  constructor(bridge) {
    this.bridge = bridge;
    this.init();
  }

  init() {
    const html = `
      <div class="dual-tavern-bridge-settings-container">
        <div class="dtb-main-settings-header" id="dtb_main_settings_toggle">
          <div class="dtb-main-settings-title">
            <span class="dtb-main-icon">🎭</span>
            <span>Dual Tavern Bridge 设置</span>
          </div>
          <span class="dtb-arrow-icon">▼</span>
        </div>
        
        <div class="dtb-main-settings-content collapsed" id="dtb_main_settings_body">
          <div class="dual-tavern-bridge-settings">
            <!-- 连接设置 -->
            <div class="dtb-panel">
              <div class="dtb-panel-header" data-panel="dtb_connection">
                <div class="dtb-panel-title">
                  <span class="dtb-panel-icon">▼</span>
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
                  <label class="dtb-checkbox-label" for="dtb_enabled">启用插件</label>
                </div>
                <div class="dtb-form-group">
                  <label class="dtb-form-label">服务器地址</label>
                  <div class="dtb-form-row">
                    <input type="text" id="dtb_server_url" class="dtb-input" placeholder="wss://..." />
                    <button id="dtb_connect_btn" class="dtb-button primary">连接</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 房间管理 -->
            <div class="dtb-panel">
              <div class="dtb-panel-header" data-panel="dtb_room">
                <div class="dtb-panel-title">
                  <span class="dtb-panel-icon">▼</span>
                  <span>🏠 房间管理</span>
                </div>
              </div>
              <div class="dtb-panel-content collapsed" id="dtb_room_content">
                <div id="dtb_create_join_section">
                  <button id="dtb_create_room" class="dtb-button primary" style="width:100%">创建房间</button>
                  <div class="dtb-divider"></div>
                  <div class="dtb-form-row">
                    <input type="text" id="dtb_room_code_input" class="dtb-input" placeholder="6位房间码" maxlength="6" />
                    <button id="dtb_join_room" class="dtb-button">加入</button>
                  </div>
                </div>
                <div id="dtb_room_info" style="display: none;">
                  <div class="dtb-room-card">
                    <label class="dtb-form-label">当前房间</label>
                    <div class="dtb-room-code-display">
                      <span id="dtb_room_code_display">------</span>
                      <button id="dtb_copy_room_code" class="dtb-button dtb-copy-button">复制</button>
                    </div>
                  </div>
                  <button id="dtb_leave_room" class="dtb-button danger" style="width: 100%; margin-top: 8px;">离开房间</button>
                </div>
              </div>
            </div>

            <!-- 模式设置 -->
            <div class="dtb-panel">
              <div class="dtb-panel-header" data-panel="dtb_mode">
                <div class="dtb-panel-title">
                  <span class="dtb-panel-icon">▼</span>
                  <span>🎭 模式设置</span>
                </div>
              </div>
              <div class="dtb-panel-content collapsed" id="dtb_mode_content">
                <div class="dtb-checkbox-wrapper">
                  <input type="checkbox" id="dtb_roleplay_mode" />
                  <label class="dtb-checkbox-label" for="dtb_roleplay_mode">启用角色扮演模式</label>
                </div>
                <div class="dtb-hint">
                  开启后，你将扮演当前角色与对方互动。<br>
                  关闭则为双人协作模式，共同生成 AI 回复。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // 注入到 ST 设置区域
    const container = $('#extensions_settings');
    if (container.length && $('#dual-tavern-bridge-settings-container').length === 0) {
      container.append(html);
    } else {
      $('body').append(html); // Fallback
    }

    this.bindEvents();
    this.loadState();
  }

  bindEvents() {
    // 折叠/展开
    $('#dtb_main_settings_toggle').on('click', () => {
      $('#dtb_main_settings_body').toggleClass('collapsed');
      this.updateIcons();
    });

    $('.dtb-panel-header').on('click', function () {
      const panelId = $(this).data('panel');
      $(`#${panelId}_content`).toggleClass('collapsed');
      // Update icon logic here if needed
    });

    // 设置变更
    $('#dtb_enabled').on('change', (e) => this.bridge.updateSetting('enabled', e.target.checked));
    $('#dtb_server_url').on('change', (e) => this.bridge.updateSetting('serverUrl', e.target.value));
    $('#dtb_roleplay_mode').on('change', (e) => this.bridge.updateSetting('rolePlayMode', e.target.checked));

    // 按钮事件
    $('#dtb_connect_btn').on('click', () => this.bridge.toggleConnection());
    $('#dtb_create_room').on('click', () => this.bridge.network.send('create_room', {}));
    $('#dtb_join_room').on('click', () => {
      const roomId = $('#dtb_room_code_input').val().trim().toUpperCase();
      if (roomId.length === 6) this.bridge.network.send('join_room', { roomId });
      else toastr.warning('请输入6位房间码', EXTENSION_NAME);
    });
    $('#dtb_leave_room').on('click', () => this.bridge.leaveRoom());
    $('#dtb_copy_room_code').on('click', () => Utils.copyToClipboard($('#dtb_room_code_display').text()));
  }

  updateIcons() {
    const isCollapsed = $('#dtb_main_settings_body').hasClass('collapsed');
    $('#dtb_main_settings_toggle .dtb-arrow-icon').text(isCollapsed ? '▼' : '▲');
  }

  loadState() {
    const settings = Utils.loadSettings();
    $('#dtb_enabled').prop('checked', settings.enabled);
    $('#dtb_server_url').val(settings.serverUrl);
    $('#dtb_roleplay_mode').prop('checked', settings.rolePlayMode);
  }

  updateConnectionUI(connected) {
    const dot = $('#dtb_status_dot');
    const text = $('#dtb_status_text');
    const btn = $('#dtb_connect_btn');

    if (connected) {
      dot.addClass('connected');
      text.text('已连接');
      btn.text('断开').removeClass('primary').addClass('danger');
    } else {
      dot.removeClass('connected');
      text.text('未连接');
      btn.text('连接').removeClass('danger').addClass('primary');
    }
  }

  updateRoomUI(roomId) {
    if (roomId) {
      $('#dtb_create_join_section').hide();
      $('#dtb_room_info').show();
      $('#dtb_room_code_display').text(roomId);
    } else {
      $('#dtb_create_join_section').show();
      $('#dtb_room_info').hide();
    }
  }
}

// ===== 聊天覆盖层类 =====
class ChatOverlay {
  constructor(bridge) {
    this.bridge = bridge;
    this.init();
  }

  init() {
    const html = `
      <div class="dtb-quick-actions">
        <button class="dtb-fab primary" id="dtb_toggle_chat_ui" title="打开聊天">
          🎭
          <span class="dtb-fab-badge" id="dtb_notification_badge" style="display: none;">!</span>
        </button>
      </div>

      <div class="dtb-chat-overlay" id="dtb_chat_overlay">
        <div class="dtb-chat-header" id="dtb_chat_header_drag">
          <div class="dtb-chat-header-left">
            <span class="dtb-chat-status-indicator" id="dtb_chat_overlay_status"></span>
            <span class="dtb-chat-title">Dual Tavern Bridge</span>
          </div>
          <div class="dtb-chat-header-actions">
            <button class="dtb-icon-button" id="dtb_chat_settings_btn">⚙️</button>
            <button class="dtb-icon-button" id="dtb_chat_minimize_btn">➖</button>
            <button class="dtb-icon-button close" id="dtb_chat_close_btn">✕</button>
          </div>
        </div>

        <div class="dtb-chat-body">
          <!-- 左侧：我的信息 -->
          <div class="dtb-chat-sidebar left">
            <div class="dtb-section-title">我的信息</div>
            <div id="dtb_my_info_display"></div>
            <button id="dtb_update_my_info" class="dtb-button small">🔄 更新</button>
          </div>

          <!-- 中间：聊天/主要信息 -->
          <div class="dtb-chat-center">
            <!-- 顶部信息栏 (协作模式显示共同角色，RP模式显示对方信息) -->
            <div class="dtb-center-info-panel collapsed" id="dtb_center_info_panel">
              <div class="dtb-center-info-header">
                <span id="dtb_center_info_title">角色信息</span>
                <span class="dtb-arrow-icon">▼</span>
              </div>
              <div class="dtb-center-info-content" id="dtb_center_info_content">
                <!-- 动态内容 -->
              </div>
            </div>

            <div class="dtb-chat-messages" id="dtb_chat_messages">
              <div class="dtb-empty-state">
                <div class="dtb-empty-icon">💬</div>
                <div class="dtb-empty-text">等待连接...</div>
              </div>
            </div>

            <div class="dtb-chat-input-area">
              <textarea id="dtb_chat_input" class="dtb-chat-input" placeholder="输入消息..." rows="1"></textarea>
              <button id="dtb_chat_send" class="dtb-chat-send-btn" disabled>✈️</button>
            </div>
          </div>

          <!-- 右侧：对方状态 (简化) -->
          <div class="dtb-chat-sidebar right">
            <div class="dtb-section-title">对方状态</div>
            <div id="dtb_partner_status_display">
              <div class="dtb-empty-text">等待加入</div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('body').append(html);
    this.bindEvents();
    this.makeDraggable();
  }

  bindEvents() {
    $('#dtb_toggle_chat_ui').on('click', () => {
      $('#dtb_chat_overlay').toggleClass('active');
      $('#dtb_notification_badge').hide();
    });

    $('#dtb_chat_close_btn').on('click', () => $('#dtb_chat_overlay').removeClass('active'));
    $('#dtb_chat_minimize_btn').on('click', () => $('#dtb_chat_overlay').toggleClass('minimized'));
    $('#dtb_chat_settings_btn').on('click', () => {
      $('#dtb_chat_overlay').removeClass('active');
      $('#extensions_settings').click();
    });

    $('#dtb_chat_send').on('click', () => this.bridge.sendMessage());
    $('#dtb_chat_input').on('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.bridge.sendMessage();
      }
    });

    $('#dtb_update_my_info').on('click', () => this.bridge.syncMyInfo());

    // 中间信息栏折叠
    $('.dtb-center-info-header').on('click', () => {
      $('#dtb_center_info_panel').toggleClass('collapsed');
    });
  }

  makeDraggable() {
    const overlay = document.getElementById('dtb_chat_overlay');
    const header = document.getElementById('dtb_chat_header_drag');
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      header.style.cursor = 'grabbing';

      // Reset transform to absolute position
      overlay.style.transform = 'none';
      overlay.style.left = `${initialLeft}px`;
      overlay.style.top = `${initialTop}px`;
      overlay.style.bottom = 'auto';
      overlay.style.right = 'auto';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      overlay.style.left = `${initialLeft + dx}px`;
      overlay.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      header.style.cursor = 'grab';
    });
  }

  updateDisplay() {
    const settings = Utils.loadSettings();
    const isRolePlay = settings.rolePlayMode;

    // 1. 更新我的信息 (左侧)
    this.renderMyInfo(isRolePlay);

    // 2. 更新中间面板 (共同角色 或 对方信息)
    this.renderCenterPanel(isRolePlay);

    // 3. 更新对方状态 (右侧)
    this.renderPartnerStatus(isRolePlay);
  }

  renderMyInfo(isRolePlay) {
    const container = $('#dtb_my_info_display');
    if (isRolePlay) {
      // RP模式：显示我的角色卡 (当前ST选中的角色)
      const context = SillyTavern.getContext();
      const char = context.characters[context.characterId];
      if (char) {
        container.html(this.createMiniCard(char.name, char.avatar, '我的角色'));
      } else {
        container.html('<div class="dtb-empty-text">未选择角色</div>');
      }
    } else {
      // 协作模式：显示我的 Persona
      const persona = Utils.getUserPersona();
      container.html(this.createMiniCard(persona.name, persona.avatar, '我的形象'));
    }
  }

  renderCenterPanel(isRolePlay) {
    const container = $('#dtb_center_info_content');
    const title = $('#dtb_center_info_title');

    if (isRolePlay) {
      // RP模式：显示对方的角色信息
      title.text('对方角色信息');
      const partner = this.bridge.partnerCharacter;
      if (partner) {
        container.html(`
          <div class="dtb-info-block">
            <strong>${partner.name}</strong>
            <p>${partner.description || '暂无描述'}</p>
          </div>
        `);
      } else {
        container.html('<div class="dtb-empty-text">等待对方同步...</div>');
      }
    } else {
      // 协作模式：显示共同对话的角色 (ST当前选中的角色)
      title.text('共同对话角色');
      const context = SillyTavern.getContext();
      const char = context.characters[context.characterId];
      if (char) {
        container.html(`
          <div class="dtb-info-block">
            <strong>${char.name}</strong>
            <p>${char.data?.description || char.description || '暂无描述'}</p>
          </div>
        `);
      } else {
        container.html('<div class="dtb-empty-text">请在 ST 中选择一个角色</div>');
      }
    }
  }

  renderPartnerStatus(isRolePlay) {
    const container = $('#dtb_partner_status_display');
    const partner = this.bridge.partnerCharacter;

    if (partner) {
      container.html(this.createMiniCard(partner.name, null, isRolePlay ? '对方' : '协作伙伴'));
    } else {
      container.html('<div class="dtb-empty-text">等待加入...</div>');
    }
  }

  createMiniCard(name, avatar, label) {
    return `
      <div class="dtb-mini-card">
        <div class="dtb-mini-avatar">${avatar ? `<img src="${avatar}" />` : '👤'}</div>
        <div class="dtb-mini-info">
          <div class="dtb-mini-name">${name}</div>
          <div class="dtb-mini-label">${label}</div>
        </div>
      </div>
    `;
  }

  addMessage(name, text, isUser) {
    const container = $('#dtb_chat_messages');
    container.find('.dtb-empty-state').remove();

    const html = `
      <div class="dtb-message-item ${isUser ? 'user' : ''}">
        <div class="dtb-message-avatar">${isUser ? '👤' : '🎭'}</div>
        <div class="dtb-message-content">
          <div class="dtb-message-header">
            <span class="dtb-message-name">${name}</span>
            <span class="dtb-message-time">${new Date().toLocaleTimeString()}</span>
          </div>
          <div class="dtb-message-text">${text}</div>
        </div>
      </div>
    `;

    container.append(html);
    container.scrollTop(container[0].scrollHeight);
  }
}

// ===== 主控制类 =====
class DualTavernBridge {
  constructor() {
    this.network = new NetworkManager(this);
    this.settingsPanel = new SettingsPanel(this);
    this.chatOverlay = new ChatOverlay(this);

    this.currentRoomId = null;
    this.partnerCharacter = null;

    this.init();
  }

  init() {
    // 监听 ST 事件
    eventSource.on(event_types.MESSAGE_SENT, (id) => this.onMessageSent(id));

    // 自动连接
    const settings = Utils.loadSettings();
    if (settings.enabled && settings.serverUrl) {
      this.network.connect();
    }
  }

  updateSetting(key, value) {
    const settings = Utils.loadSettings();
    settings[key] = value;
    Utils.saveSettings(settings);

    if (key === 'rolePlayMode') {
      this.chatOverlay.updateDisplay();
    }
  }

  toggleConnection() {
    if (this.network.ws) {
      this.network.disconnect();
    } else {
      this.network.connect();
    }
  }

  updateConnectionStatus(connected) {
    this.settingsPanel.updateConnectionUI(connected);
    $('#dtb_chat_overlay_status').toggleClass('connected', connected);
  }

  // 房间事件处理
  handleRoomCreated(payload) {
    this.currentRoomId = payload.roomId;
    this.settingsPanel.updateRoomUI(this.currentRoomId);
    toastr.success(`房间创建成功: ${this.currentRoomId}`, EXTENSION_NAME);
    this.chatOverlay.updateDisplay();
  }

  handleRoomJoined(payload) {
    this.currentRoomId = payload.roomId;
    this.settingsPanel.updateRoomUI(this.currentRoomId);
    toastr.success(`加入房间成功`, EXTENSION_NAME);
    this.chatOverlay.updateDisplay();
  }

  leaveRoom() {
    if (this.currentRoomId) {
      this.network.send('leave_room', { roomId: this.currentRoomId });
      this.currentRoomId = null;
      this.partnerCharacter = null;
      this.settingsPanel.updateRoomUI(null);
      this.chatOverlay.updateDisplay();
    }
  }

  // 伙伴事件处理
  handlePartnerJoined(payload) {
    toastr.info('对方已加入房间', EXTENSION_NAME);
    // 请求同步信息
    this.syncMyInfo();
  }

  handlePartnerLeft() {
    toastr.info('对方已离开', EXTENSION_NAME);
    this.partnerCharacter = null;
    this.chatOverlay.updateDisplay();
  }

  handlePartnerMessage(payload) {
    const { message, characterName, isRoleResponse } = payload;

    // 如果是同步信息消息
    if (payload.type === 'sync_info') {
      this.partnerCharacter = payload.character;
      this.chatOverlay.updateDisplay();
      return;
    }

    this.chatOverlay.addMessage(characterName || 'Partner', message, false);

    if (!isRoleResponse) {
      // 协作模式：收到对方输入，暂存或显示
      // TODO: 实现协作模式逻辑
    }
  }

  // 信息同步
  syncMyInfo() {
    const settings = Utils.loadSettings();
    let myInfo;

    if (settings.rolePlayMode) {
      // RP模式：发送我的角色信息
      const context = SillyTavern.getContext();
      const char = context.characters[context.characterId];
      if (char) {
        myInfo = {
          name: char.name,
          description: char.description,
          avatar: char.avatar // 注意：可能需要处理图片路径
        };
      }
    } else {
      // 协作模式：发送我的 Persona
      myInfo = Utils.getUserPersona();
    }

    if (myInfo) {
      this.network.send('send_message', {
        type: 'sync_info',
        character: myInfo
      });
      toastr.success('信息已同步', EXTENSION_NAME);
    }

    this.chatOverlay.updateDisplay();
  }

  // 消息发送逻辑
  sendMessage() {
    const input = $('#dtb_chat_input');
    const message = input.val().trim();
    if (!message) return;

    this.chatOverlay.addMessage('我', message, true);

    const settings = Utils.loadSettings();
    if (settings.rolePlayMode) {
      // RP模式：直接发送
      this.network.send('roleplay_message', {
        message: message,
        characterName: this.partnerCharacter?.name || 'User'
      });
    } else {
      // 协作模式：发送输入
      this.network.send('send_message', {
        message: message
      });
    }

    input.val('');
  }

  onMessageSent(messageId) {
    // 监听 ST 主聊天框的消息发送 (用于触发协作生成等)
    const settings = Utils.loadSettings();
    if (!settings.enabled || !this.currentRoomId) return;

    // TODO: 实现拦截 ST 消息并转发的逻辑
  }
}

// 初始化
jQuery(async () => {
  window.dualTavernBridge = new DualTavernBridge();
  console.log(`✅ ${EXTENSION_NAME} Loaded (Component Based)`);
});
