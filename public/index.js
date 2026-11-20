// 获取当前页面的基础 URL
const baseUrl = window.location.origin

// 当前激活的选项卡
let currentTab = 'hosts'

function escapeHtml(str) {
  const div = document.createElement("div")
  div.textContent = str
  return div.innerHTML
}

// 显示消息
function showMessage(message, type = 'info') {
  const container = document.createElement('div')
  container.className = `message ${type}`
  container.textContent = message
  
  //  插入到当前活动选项卡的顶部
  const activeTab = document.querySelector('.tab-content.active')
  if (activeTab) {
    activeTab.insertBefore(container, activeTab.firstChild)
    
    // 3秒后自动删除
    setTimeout(() => {
      if (container.parentNode) {
        container.parentNode.removeChild(container)
      }
    }, 3000)
  }
}

// 复制到剪贴板
async function copyToClipboard(text, btn) {
  try {
    if (typeof text === 'object') {
      // 如果传入的是按钮元素（旧的调用方式）
      const hostsElement = document.getElementById("hosts")
      await navigator.clipboard.writeText(hostsElement.textContent)
      btn = text
    } else {
      // 如果传入的是文本
      await navigator.clipboard.writeText(text)
    }

    const originalText = btn.textContent
    btn.textContent = "已复制"
    btn.style.backgroundColor = '#10b981'

    setTimeout(() => {
      btn.textContent = originalText
      btn.style.backgroundColor = ''
    }, 1000)
  } catch (err) {
    console.error("复制失败:", err)
    showMessage('复制失败，请手动选择复制', 'error')
  }
}

// 缓存 hosts 内容和更新时间
let cachedHostsContent = null
let lastHostsUpdate = null
const HOSTS_CACHE_DURATION = 60 * 60 * 1000 // 1小时缓存
let autoRefreshTimer = null

// 从 localStorage 恢复缓存
function restoreCache() {
  try {
    const cached = localStorage.getItem('hosts_cache')
    const timestamp = localStorage.getItem('hosts_cache_timestamp')
    
    if (cached && timestamp) {
      const now = Date.now()
      const cacheTime = parseInt(timestamp)
      
      // 如果缓存未过期，恢复缓存
      if (now - cacheTime < HOSTS_CACHE_DURATION) {
        cachedHostsContent = cached
        lastHostsUpdate = cacheTime
        console.log('从 localStorage 恢复缓存，剩余时间:', Math.round((HOSTS_CACHE_DURATION - (now - cacheTime)) / 60000), '分钟')
        return true
      } else {
        // 清除过期缓存
        console.log('localStorage 缓存已过期，清除缓存')
        localStorage.removeItem('hosts_cache')
        localStorage.removeItem('hosts_cache_timestamp')
      }
    }
  } catch (error) {
    console.warn('恢复缓存失败:', error)
  }
  return false
}

// 强制清除所有缓存
function forceClearCache() {
  console.log('强制清除所有缓存')
  cachedHostsContent = null
  lastHostsUpdate = null
  localStorage.removeItem('hosts_cache')
  localStorage.removeItem('hosts_cache_timestamp')
  
  // 清除定时器
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer)
    autoRefreshTimer = null
  }
}

// 保存缓存到 localStorage
function saveCache(content, timestamp) {
  try {
    localStorage.setItem('hosts_cache', content)
    localStorage.setItem('hosts_cache_timestamp', timestamp.toString())
  } catch (error) {
    console.warn('保存缓存失败:', error)
  }
}

// 更新状态显示
function updateHostsStatus(message, type = 'info') {
  const statusElement = document.getElementById('hostsStatus')
  if (statusElement) {
    statusElement.textContent = message
    statusElement.className = `status-text ${type}`
  }
}

// 更新缓存状态显示
function updateCacheStatus(message, type = 'cached') {
  const cacheStatusElement = document.getElementById('cacheStatus')
  if (cacheStatusElement) {
    cacheStatusElement.textContent = `缓存状态：${message}`
    cacheStatusElement.className = `cache-status-text ${type}`
  }
}

// 计算下次更新时间并显示倒计时
function updateCountdown() {
  if (!lastHostsUpdate) return
  
  const now = Date.now()
  const timeLeft = HOSTS_CACHE_DURATION - (now - lastHostsUpdate)
  
  if (timeLeft > 0) {
    const minutes = Math.ceil(timeLeft / (60 * 1000))
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    
    let timeText = ''
    if (hours > 0) {
      timeText = `${hours}小时${mins}分钟`
    } else {
      timeText = `${mins}分钟`
    }
    
    updateHostsStatus(`使用缓存数据，${timeText}后自动更新`, 'info')
    console.log(`Hosts缓存状态: 剩余${timeText}`)
  } else {
    // 缓存已过期，触发更新
    console.log('Hosts缓存已过期，触发自动更新')
    if (currentTab === 'hosts') {
      loadHosts(true)
    }
  }
}

// 加载 hosts 内容
async function loadHosts(forceRefresh = false) {
  const hostsElement = document.getElementById("hosts")
  if (!hostsElement) {
    console.error('无法找到 hosts 元素，页面可能未完全加载')
    // 等待 1秒 后重试
    setTimeout(() => {
      console.log('重试加载 hosts 内容...')
      loadHosts(forceRefresh)
    }, 1000)
    return
  }

  const now = Date.now()
  
  console.log(`loadHosts调用: forceRefresh=${forceRefresh}, 缓存时间=${lastHostsUpdate ? new Date(lastHostsUpdate).toLocaleString() : '无'}`)
  console.log('hosts元素状态:', hostsElement ? '找到' : '未找到')
  
  // 强制刷新时跳过缓存检查
  if (forceRefresh) {
    console.log('强制刷新模式：跳过缓存检查，直接获取新数据')
    updateCacheStatus('正在获取最新数据...', 'updating')
  } else if (cachedHostsContent && lastHostsUpdate &&
      (now - lastHostsUpdate < HOSTS_CACHE_DURATION)) {
    console.log('使用缓存数据显示hosts内容')
    hostsElement.textContent = cachedHostsContent
    const cacheAge = Math.round((now - lastHostsUpdate) / (60 * 1000))
    updateCacheStatus(`使用缓存数据 (${cacheAge}分钟前)`, 'cached')
    updateCountdown()
    return
  }

  try {
    console.log('开始获取hosts数据...')
    // 显示更新状态
    updateHostsStatus('正在更新 hosts 数据...', 'updating')
    
    // 始终显示加载状态，避免缓存内容干扰用户体验
    hostsElement.textContent = "正在加载 hosts 内容..."
    
    // 默认启用 IP 优选和自定义域名功能
    const optimize = true
    const custom = true
    
    const params = new URLSearchParams()
    // 明确传递参数，确保自定义域名功能启用
    params.append('optimize', optimize.toString())
    params.append('custom', custom.toString())
    if (forceRefresh) params.append('refresh', 'true')
    
    const queryString = params.toString()
    const url = `${baseUrl}/hosts?${queryString}`
    
    console.log('发起 API 请求:', url)
    console.log('请求参数:', { optimize, custom, forceRefresh })
    
    // 添加防缓存头，确保获取最新数据
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    }
    
    // 如果是强制刷新，在URL中添加时间戳确保绕过所有缓存
    const finalUrl = forceRefresh ? `${url}&_t=${now}` : url
    console.log('最终请求URL:', finalUrl)
    
    const response = await fetch(finalUrl, fetchOptions)
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const hostsContent = await response.text()
    console.log(`成功获取hosts数据，长度: ${hostsContent.length}`)
    console.log('Hosts内容预览:', hostsContent.substring(0, 500) + '...')
    
    // 检查是否包含自定义域名的特征
    const customDomainCount = (hostsContent.match(/# Custom Domains|自定义域名/gi) || []).length
    console.log(`Hosts文件中自定义域名标记数量: ${customDomainCount}`)
    
    // 检查内容是否有效
    if (!hostsContent || hostsContent.length < 100) {
      throw new Error('获取的 hosts 内容为空或太短')
    }
    
    // 更新缓存和显示内容
    const isContentChanged = cachedHostsContent !== hostsContent
    cachedHostsContent = hostsContent
    lastHostsUpdate = now
    hostsElement.textContent = hostsContent
    
    // 保存到 localStorage
    saveCache(hostsContent, now)
    console.log(`hosts内容${isContentChanged ? '已' : '未'}更新，已保存到缓存`)
    
    // 如果是强制刷新，总是显示更新成功
    if (forceRefresh) {
      console.log('强制刷新完成，显示更新成功状态')
      updateHostsStatus('hosts 内容已强制更新', 'success')
      updateCacheStatus('显示最新数据', 'fresh')
      showMessage('hosts 内容已强制更新', 'success')
      setTimeout(() => {
        updateCountdown()
      }, 3000)
    } else {
      // 更新状态
      if (isContentChanged) {
        updateHostsStatus('hosts 内容已更新', 'success')
        updateCacheStatus('显示最新数据', 'fresh')
        setTimeout(() => {
          updateCountdown()
        }, 3000)
      } else {
        updateCacheStatus('显示最新数据', 'fresh')
        updateCountdown()
      }

      // 如果是后台更新且内容有变化，显示提示
      if (isContentChanged) {
        showMessage('hosts 内容已更新', 'success')
      }
    }
    
    // 重新设置自动刷新定时器
    setupAutoRefresh()
    
  } catch (error) {
    console.error("获取hosts数据失败:", error)
    // 如果有缓存，保持显示缓存内容
    if (!cachedHostsContent) {
      hostsElement.textContent = "加载 hosts 内容失败，请稍后重试"
    }
    updateHostsStatus('更新失败，使用缓存数据', 'error')
    showMessage('加载失败，请稍后重试', 'error')
    
    // 即使失败也要设置重试定时器
    setupAutoRefresh()
  }
}

// 设置自动刷新定时器
function setupAutoRefresh() {
  // 清除现有定时器
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer)
  }
  
  if (!lastHostsUpdate) return
  
  const now = Date.now()
  const timeLeft = HOSTS_CACHE_DURATION - (now - lastHostsUpdate)
  
  if (timeLeft > 0) {
    // 设置在缓存过期时自动刷新
    autoRefreshTimer = setTimeout(() => {
      if (currentTab === 'hosts') {
        console.log('自动刷新 hosts 内容')
        loadHosts(true)
      }
    }, timeLeft)
  } else {
    // 缓存已过期，立即刷新
    if (currentTab === 'hosts') {
      loadHosts(true)
    }
  }
}

// 设置倒计时更新定时器（内存泄漏修复）
let countdownTimerInterval = null

function setupCountdownTimer() {
  // 清理之前的定时器
  if (countdownTimerInterval) {
    clearInterval(countdownTimerInterval)
  }
  
  // 每分钟更新一次倒计时显示
  countdownTimerInterval = setInterval(() => {
    if (currentTab === 'hosts' && lastHostsUpdate) {
      updateCountdown()
    }
  }, 60 * 1000) // 每分钟更新
}

// 清理定时器函数
function cleanupTimers() {
  if (countdownTimerInterval) {
    clearInterval(countdownTimerInterval)
    countdownTimerInterval = null
  }
}

// 选项卡切换
function switchTab(tabName) {
  // 更新选项卡状态
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.remove('active')
  })
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active')
  
  // 更新内容区域
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active')
  })
  document.getElementById(`${tabName}-tab`).classList.add('active')
  
  currentTab = tabName
  
  // 根据选项卡加载相应内容
  if (tabName === 'hosts') {
    // 只有在没有缓存或缓存过期时才加载
    const now = Date.now()
    const needRefresh = !cachedHostsContent || !lastHostsUpdate || 
                       (now - lastHostsUpdate >= HOSTS_CACHE_DURATION)
    
    if (needRefresh) {
      loadHosts(false) // 不强制刷新，让函数内部判断
    } else {
      // 使用缓存显示
      const hostsElement = document.getElementById("hosts")
      if (hostsElement && cachedHostsContent) {
        hostsElement.textContent = cachedHostsContent
        updateCountdown()
      }
    }
  }
}

// 智能重试机制
async function retryWithBackoff(fn, maxRetries = 2, baseDelay = 1000) {
  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`尝试第 ${attempt + 1} 次 (共 ${maxRetries + 1} 次)`)
      return await fn()
    } catch (error) {
      lastError = error
      console.error(`第 ${attempt + 1} 次尝试失败:`, error.message)

      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxRetries) {
        console.error('所有重试尝试都失败了')
        throw lastError
      }

      // 计算延迟时间（指数退避）
      const delay = baseDelay * Math.pow(2, attempt)
      console.log(`等待 ${delay}ms 后重试...`)

      // 显示重试信息给用户
      showMessage(`第 ${attempt + 1} 次尝试失败，${delay/1000}秒后重试...`, 'info')

      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

// 检查网络连接状态
async function checkNetworkConnection() {
  try {
    // 尝试访问一个简单的端点来检查连接
    const response = await fetch(`${baseUrl}/hosts.json`, {
      method: 'GET',
      cache: 'no-cache',
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch (error) {
    console.warn('网络连接检查失败:', error)
    return false
  }
}

// 智能缓存清理和数据同步
async function performIntelligentCacheRefresh(optimizeResult) {
  console.log('=== 开始智能缓存清理和数据同步 ===')
  console.log('优选结果:', optimizeResult)

  // 记录清理前的状态
  const beforeState = {
    cachedContentLength: cachedHostsContent?.length || 0,
    lastUpdate: lastHostsUpdate ? new Date(lastHostsUpdate).toLocaleString() : 'null',
    localStorageSize: localStorage.getItem('hosts_cache')?.length || 0,
    hasAutoRefreshTimer: !!autoRefreshTimer
  }
  console.log('清理前状态:', beforeState)

  // 第一步：彻底清除所有缓存
  console.log('第一步：清除所有缓存...')
  cachedHostsContent = null
  lastHostsUpdate = null
  localStorage.removeItem('hosts_cache')
  localStorage.removeItem('hosts_cache_timestamp')

  // 清除定时器
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer)
    autoRefreshTimer = null
    console.log('已清除自动刷新定时器')
  }

  if (countdownTimerInterval) {
    clearInterval(countdownTimerInterval)
    countdownTimerInterval = null
    console.log('已清除倒计时定时器')
  }

  console.log('缓存清除完成')

  // 第二步：更新UI状态
  console.log('第二步：更新UI状态...')
  updateHostsStatus('正在同步最新数据...', 'updating')
  updateCacheStatus('正在同步优选结果...', 'updating')

  const hostsElement = document.getElementById("hosts")
  if (hostsElement) {
    hostsElement.textContent = "正在同步最新 hosts 内容，请稍候..."
    console.log('已更新hosts元素显示状态')
  }

  // 第三步：验证后端数据是否已更新
  console.log('第三步：验证后端数据同步状态...')

  try {
    // 等待一小段时间确保后端数据已写入
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 检查后端数据状态
    const statusResponse = await fetch(`${baseUrl}/hosts.json?refresh=true&_t=${Date.now()}`, {
      method: 'GET',
      cache: 'no-cache',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    })

    if (statusResponse.ok) {
      const statusData = await statusResponse.json()
      console.log('后端数据状态检查成功:', {
        total: statusData.total,
        github: statusData.github?.length || 0,
        custom: statusData.custom?.length || 0,
        timestamp: statusData.timestamp
      })

      // 第四步：重新加载hosts内容
      console.log('第四步：重新加载hosts内容...')

      // 使用较短的延迟，因为我们已经验证了数据状态
      setTimeout(async () => {
        console.log('=== 开始重新加载hosts内容（强制刷新） ===')

        try {
          await loadHosts(true) // 强制刷新hosts内容
          console.log('hosts内容重新加载完成')
          updateCacheStatus('已同步优选结果', 'fresh')

          // 重新设置定时器
          setupCountdownTimer()
          console.log('已重新设置倒计时定时器')

        } catch (loadError) {
          console.error('重新加载hosts内容失败:', loadError)
          updateCacheStatus('同步失败', 'error')
          showMessage('数据同步完成，但显示更新失败，请手动刷新页面', 'error')
        }
      }, 500) // 减少到500ms

    } else {
      console.warn('后端数据状态检查失败，使用默认延迟重新加载')
      // 如果状态检查失败，使用较长的延迟
      setTimeout(() => {
        console.log('=== 开始重新加载hosts内容（默认延迟） ===')
        loadHosts(true)
      }, 2000)
    }

  } catch (error) {
    console.error('数据同步验证失败:', error)
    // 如果验证失败，使用默认策略
    setTimeout(() => {
      console.log('=== 开始重新加载hosts内容（错误恢复） ===')
      loadHosts(true)
    }, 3000)
  }
}

// 强制刷新hosts显示函数 - 简单快速刷新
async function forceRefreshHostsDisplay() {
  console.log('=== 开始强制刷新hosts显示 ===')

  const forceRefreshBtn = document.getElementById('forceRefreshDisplay')
  const originalText = forceRefreshBtn ? forceRefreshBtn.textContent : '强制刷新显示'

  try {
    // 更新按钮状态
    if (forceRefreshBtn) {
      forceRefreshBtn.textContent = '刷新中...'
      forceRefreshBtn.disabled = true
      forceRefreshBtn.style.opacity = '0.6'
    }

    updateHostsStatus('正在强制刷新hosts显示...', 'updating')
    updateCacheStatus('正在获取最新数据...', 'updating')

    // 彻底清除所有缓存
    console.log('清除所有缓存数据...')
    cachedHostsContent = null
    lastHostsUpdate = null
    localStorage.removeItem('hosts_cache')
    localStorage.removeItem('hosts_cache_timestamp')

    // 清除定时器
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer)
      autoRefreshTimer = null
    }
    if (countdownTimerInterval) {
      clearInterval(countdownTimerInterval)
      countdownTimerInterval = null
    }

    // 强制刷新hosts内容
    await loadHosts(true)

    showMessage('hosts内容已强制刷新，显示最新数据', 'success')
    updateCacheStatus('显示最新数据', 'fresh')

  } catch (error) {
    console.error('强制刷新hosts显示失败:', error)
    showMessage('强制刷新失败，请稍后重试', 'error')
    updateHostsStatus('刷新失败', 'error')
    updateCacheStatus('刷新失败', 'error')
  } finally {
    // 恢复按钮状态
    if (forceRefreshBtn) {
      forceRefreshBtn.textContent = originalText
      forceRefreshBtn.disabled = false
      forceRefreshBtn.style.opacity = '1'
    }
  }
}

// 全域名优选函数 - 主页立即刷新功能
async function optimizeAllDomains() {
  debugLog('info', '开始执行全域名优选')
  console.log('=== 开始执行全域名优选 ===')
  console.log('时间戳:', new Date().toISOString())
  console.log('当前页面URL:', window.location.href)
  console.log('baseUrl:', baseUrl)

  const refreshBtn = document.getElementById('refreshHosts')
  const originalText = refreshBtn ? refreshBtn.textContent : '立即全域名优选'

  console.log('刷新按钮状态:', refreshBtn ? '找到' : '未找到')
  console.log('按钮原始文本:', originalText)

  // 记录开始时间用于性能监控
  const startTime = Date.now()
  let requestSent = false
  let responseReceived = false

  try {
    // 更新按钮状态
    if (refreshBtn) {
      refreshBtn.textContent = '正在优选...'
      refreshBtn.disabled = true
      refreshBtn.style.opacity = '0.6'
      console.log('按钮状态已更新为禁用状态')
    }

    updateHostsStatus('正在执行全域名优选，请稍候...', 'updating')
    showMessage('开始执行全域名优选（包括GitHub域名和自定义域名），这可能需要1-2分钟时间...', 'info')

    // 构建请求URL和参数
    const apiUrl = `${baseUrl}/api/optimize-all`
    const requestHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': 'main-page-refresh',
      'User-Agent': 'CustomHosts-Frontend/1.0',
      'Accept': 'application/json'
    }

    console.log('准备发送API请求:')
    console.log('- URL:', apiUrl)
    console.log('- Headers:', requestHeaders)
    console.log('- Method: POST')

    // 检查网络连接
    console.log('检查网络连接状态...')
    const isNetworkOk = await checkNetworkConnection()
    if (!isNetworkOk) {
      console.warn('网络连接检查失败，但继续尝试API请求')
      showMessage('网络连接可能不稳定，正在尝试连接...', 'info')
    }

    // 使用重试机制调用全域名优选API
    const response = await retryWithBackoff(async () => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => {
        console.error('单次请求超时，正在中止请求...')
        controller.abort()
      }, 120000) // 单次请求2分钟超时

      try {
        console.log('发送API请求...')
        requestSent = true

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: requestHeaders,
          signal: controller.signal,
          // 添加请求配置
          cache: 'no-cache',
          credentials: 'same-origin'
        })

        clearTimeout(timeoutId)
        responseReceived = true

        return response
      } catch (error) {
        clearTimeout(timeoutId)
        throw error
      }
    }, 2, 2000) // 最多重试2次，基础延迟2秒

    console.log('收到API响应:')
    console.log('- 状态码:', response.status)
    console.log('- 状态文本:', response.statusText)
    console.log('- 响应头:', Object.fromEntries(response.headers.entries()))
    console.log('- 响应时间:', Date.now() - startTime, 'ms')

    // 检查响应状态
    if (!response.ok) {
      console.error('API响应错误:', response.status, response.statusText)

      // 尝试解析错误响应
      let errorData
      try {
        errorData = await response.json()
        console.error('错误响应内容:', errorData)
      } catch (parseError) {
        console.error('无法解析错误响应:', parseError)
        const errorText = await response.text()
        console.error('错误响应文本:', errorText)
        errorData = { error: `HTTP ${response.status}: ${response.statusText}`, details: errorText }
      }

      throw new Error(`API请求失败: ${response.status} ${response.statusText}${errorData?.error ? ' - ' + errorData.error : ''}`)
    }

    const result = await response.json()
    console.log('API响应解析成功:', result)

    // 处理成功响应
    const githubCount = result.githubDomains || 0
    const customTotal = result.customDomains?.total || 0
    const customOptimized = result.customDomains?.optimized || 0
    const customFailed = result.customDomains?.failed || 0
    const totalOptimized = result.optimized || (githubCount + customOptimized)
    const totalFailed = result.failed || customFailed

    console.log('优选结果统计:')
    console.log('- GitHub域名:', githubCount)
    console.log('- 自定义域名总数:', customTotal)
    console.log('- 自定义域名成功:', customOptimized)
    console.log('- 自定义域名失败:', customFailed)
    console.log('- 总优选成功:', totalOptimized)
    console.log('- 总失败:', totalFailed)
    console.log('- 完整结果对象:', result)

    // 构建成功消息
    let message = `全域名优选完成！`
    const details = []

    if (githubCount > 0) {
      details.push(`GitHub域名 ${githubCount} 个`)
    }
    if (customTotal > 0) {
      details.push(`自定义域名: 成功 ${customOptimized} 个${customFailed > 0 ? `，失败 ${customFailed} 个` : ''}`)
    }

    if (details.length > 0) {
      message += ` ${details.join('，')}`
    }

    console.log('显示成功消息:', message)
    showMessage(message, 'success')

    // 更新状态监控
    statusMonitor.updateOptimizeStatus(true, Date.now() - startTime)
    debugLog('info', '全域名优选成功', {
      githubCount,
      customTotal,
      customOptimized,
      customFailed,
      totalOptimized,
      duration: Date.now() - startTime
    })

    // 智能缓存清理和数据同步
    await performIntelligentCacheRefresh(result)

  } catch (error) {
    const errorTime = Date.now() - startTime
    console.error('=== 全域名优选失败 ===')
    console.error('错误时间:', new Date().toISOString())
    console.error('执行时长:', errorTime, 'ms')
    console.error('请求已发送:', requestSent)
    console.error('响应已接收:', responseReceived)
    console.error('错误对象:', error)
    console.error('错误名称:', error.name)
    console.error('错误消息:', error.message)
    console.error('错误堆栈:', error.stack)

    let errorMessage = '全域名优选失败'
    let statusMessage = '优选失败'

    // 根据错误类型提供具体的错误信息
    if (error.name === 'AbortError') {
      errorMessage = '全域名优选超时，请检查网络连接后重试'
      statusMessage = '优选超时'
      console.error('请求被中止（超时）')
    } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
      errorMessage = '网络连接失败，请检查网络状态后重试'
      statusMessage = '网络错误'
      console.error('网络连接错误')
    } else if (error.message.includes('API请求失败')) {
      errorMessage = error.message
      statusMessage = '服务器错误'
      console.error('API服务器错误')
    } else {
      errorMessage = `全域名优选失败: ${error.message}`
      statusMessage = '未知错误'
      console.error('未知错误类型')
    }

    console.error('最终错误消息:', errorMessage)
    showMessage(errorMessage, 'error')
    updateHostsStatus(statusMessage, 'error')

    // 更新状态监控
    statusMonitor.updateOptimizeStatus(false, errorTime)
    debugLog('error', '全域名优选失败', {
      errorType: error.name,
      errorMessage: error.message,
      duration: errorTime,
      requestSent,
      responseReceived
    })

    // 如果是网络错误，提供重试建议
    if (error.name === 'TypeError' || error.name === 'AbortError') {
      statusMonitor.updateNetworkStatus('error')
      setTimeout(() => {
        showMessage('提示：如果网络不稳定，可以稍后再次点击"立即全域名优选"按钮重试', 'info')
      }, 3000)
    }

  } finally {
    const totalTime = Date.now() - startTime
    console.log('=== 全域名优选操作结束 ===')
    console.log('总执行时间:', totalTime, 'ms')
    console.log('结束时间:', new Date().toISOString())

    // 恢复按钮状态
    if (refreshBtn) {
      refreshBtn.textContent = originalText
      refreshBtn.disabled = false
      refreshBtn.style.opacity = '1'
      console.log('按钮状态已恢复:', originalText)
    }

    // 确保状态最终会恢复到正常状态
    setTimeout(() => {
      if (document.getElementById('hostsStatus')?.textContent?.includes('失败') ||
          document.getElementById('hostsStatus')?.textContent?.includes('错误') ||
          document.getElementById('hostsStatus')?.textContent?.includes('超时')) {
        console.log('检测到错误状态，恢复到缓存状态显示')
        updateCountdown()
      }
    }, 10000) // 10秒后检查并恢复状态
  }
}

// 加载自定义域名列表（已移至管理后台，此函数保留以防兼容性问题）
async function loadCustomDomains() {
  console.log('自定义域名管理功能已移至管理后台')
  return
}

// 添加自定义域名（已移至管理后台）
async function addCustomDomain() {
  showMessage('自定义域名管理功能已移至专用管理系统', 'info')
  return
}

// 批量添加自定义域名（已移至管理后台）
async function addCustomDomainsBatch() {
  showMessage('自定义域名管理功能已移至专用管理系统', 'info')
  return
}

// 删除自定义域名（已移至管理后台）
async function removeDomain(_domain) {
  showMessage('自定义域名管理功能已移至专用管理系统', 'info')
  return
}

// 优选域名（保留此函数以防HTML中有调用）
async function optimizeDomain(_domain) {
  showMessage('域名优选功能已集成到立即优选刷新中', 'info')
  return
}

// 状态检查函数
async function checkServiceStatus() {
  const statusIndicator = document.getElementById('status-indicator')
  if (!statusIndicator) return
  
  try {
    const response = await fetch(`${baseUrl}/hosts.json`)
    if (response.ok) {
      const data = await response.json()
      statusIndicator.innerHTML = `🟢 服务正常运行 (${data.total} 条记录)`
      statusIndicator.style.background = '#e8f5e8'
      statusIndicator.style.color = '#2d5a2d'
    } else {
      statusIndicator.innerHTML = '🟡 服务响应异常'
      statusIndicator.style.background = '#fff3cd'
      statusIndicator.style.color = '#856404'
    }
  } catch (error) {
    statusIndicator.innerHTML = '🔴 服务连接失败'
    statusIndicator.style.background = '#f8d7da'
    statusIndicator.style.color = '#721c24'
  }
}

// 设置事件监听器
function setupEventListeners() {
  console.log('设置事件监听器...')
  
  // 选项卡切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab')
      switchTab(tabName)
    })
  })
  
  // 复制按钮
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      const copyTarget = e.target.getAttribute('data-copy')
      
      if (copyTarget) {
        // 复制指定元素的内容
        const targetElement = document.getElementById(copyTarget)
        if (targetElement) {
          copyToClipboard(targetElement.textContent, e.target)
        }
      } else if (e.target.id === 'copyHosts') {
        // 复制 hosts 内容
        const hostsElement = document.getElementById("hosts")
        if (hostsElement) {
          copyToClipboard(hostsElement.textContent, e.target)
        }
      }
    }
  })
  
  // 刷新 hosts 按钮 - 执行全域名优选
  const refreshBtn = document.getElementById('refreshHosts')
  if (refreshBtn) {
    console.log('找到刷新按钮，绑定事件')
    refreshBtn.addEventListener('click', () => {
      console.log('刷新按钮被点击')
      optimizeAllDomains()
    })
  } else {
    console.error('无法找到刷新按钮元素')
    // 等待 500ms 后重试绑定
    setTimeout(() => {
      console.log('重试绑定刷新按钮事件...')
      const retryBtn = document.getElementById('refreshHosts')
      if (retryBtn) {
        console.log('重试成功，绑定刷新按钮事件')
        retryBtn.addEventListener('click', () => {
          console.log('刷新按钮被点击（重试绑定）')
          optimizeAllDomains()
        })
      } else {
        console.error('重试仍无法找到刷新按钮元素')
      }
    }, 500)
  }

  // 强制刷新显示按钮 - 直接刷新hosts内容
  const forceRefreshBtn = document.getElementById('forceRefreshDisplay')
  if (forceRefreshBtn) {
    console.log('找到强制刷新显示按钮，绑定事件')
    forceRefreshBtn.addEventListener('click', () => {
      console.log('强制刷新显示按钮被点击')
      forceRefreshHostsDisplay()
    })
  } else {
    console.error('无法找到强制刷新显示按钮元素')
    // 等待 500ms 后重试绑定
    setTimeout(() => {
      console.log('重试绑定强制刷新显示按钮事件...')
      const retryBtn = document.getElementById('forceRefreshDisplay')
      if (retryBtn) {
        console.log('重试成功，绑定强制刷新显示按钮事件')
        retryBtn.addEventListener('click', () => {
          console.log('强制刷新显示按钮被点击（重试绑定）')
          forceRefreshHostsDisplay()
        })
      }
    }, 500)
  }
}

// 初始化
function init() {
  console.log('开始初始化...')
  console.log('当前页面 URL:', window.location.href)
  console.log('baseUrl:', baseUrl)
  
  // 检查关键元素是否存在
  const hostsElement = document.getElementById("hosts")
  const refreshBtn = document.getElementById('refreshHosts')
  const tabElements = document.querySelectorAll('.tab')
  
  console.log('关键元素检查:')
  console.log('- hosts 元素:', hostsElement ? '存在' : '不存在')
  console.log('- 刷新按钮:', refreshBtn ? '存在' : '不存在')
  console.log('- 选项卡元素数量:', tabElements.length)
  
  // 如果关键元素不存在，等待 DOM 完全加载后重试
  if (!hostsElement || !refreshBtn) {
    console.warn('关键元素缺失，2秒后重试初始化...')
    setTimeout(() => {
      console.log('重试初始化...')
      init()
    }, 2000)
    return
  }
  
  setupEventListeners()
  
  // 初始化 SwitchHosts URL
  const switchHostsUrlElement = document.getElementById('switchHostsUrl')
  if (switchHostsUrlElement) {
    switchHostsUrlElement.textContent = `${baseUrl}/hosts`
    console.log('SwitchHosts URL 已设置')
  } else {
    console.warn('无法找到 switchHostsUrl 元素')
  }
  
  // 恢复缓存
  const hasCachedData = restoreCache()
  console.log('缓存恢复状态:', hasCachedData)
  
  // 检查 URL 参数，是否需要强制刷新
  const urlParams = new URLSearchParams(window.location.search)
  const forceRefreshParam = urlParams.get('refresh') === 'true'
  
  if (forceRefreshParam) {
    console.log('检测到 URL 参数要求强制刷新，清除所有缓存')
    forceClearCache()
  }
  
  // 加载初始内容
  if (currentTab === 'hosts') {
    console.log('当前标签页是 hosts，开始加载内容')
    
    // 如果有强制刷新参数或缓存已清除，直接加载新数据
    if (forceRefreshParam || !hasCachedData) {
      console.log('强制刷新或无缓存，直接加载新数据')
      loadHosts(true)
    } else if (hasCachedData) {
      // 如果有缓存，先显示缓存内容
      if (hostsElement && cachedHostsContent) {
        hostsElement.textContent = cachedHostsContent
        const cacheAge = Math.round((Date.now() - lastHostsUpdate) / (60 * 1000))
        updateCacheStatus(`使用缓存数据 (${cacheAge}分钟前)`, 'cached')
        updateCountdown()
        console.log('显示缓存内容')

        // 在后台检查是否需要更新
        const now = Date.now()
        if (now - lastHostsUpdate >= HOSTS_CACHE_DURATION) {
          console.log('缓存过期，后台更新')
          updateCacheStatus('缓存已过期，正在更新...', 'updating')
          loadHosts(true) // 缓存过期，后台更新
        } else {
          console.log('缓存有效，设置自动刷新定时器')
          setupAutoRefresh() // 设置自动刷新定时器
        }
      }
    } else {
      // 没有缓存，首次加载
      console.log('没有缓存，首次加载')
      updateCacheStatus('首次加载中...', 'updating')
      loadHosts(false)
    }
  }
  
  // 设置倒计时更新定时器
  setupCountdownTimer()
  
  // 检查服务状态
  checkServiceStatus()
  
  console.log('初始化完成')
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init)

// 页面卸载时清理所有定时器
window.addEventListener('beforeunload', () => {
  // 清理所有定时器
  cleanupTimers()
  
  // 记录当前状态到日志
  console.log('页面卸载，资源已清理')
})

// 页面可见性变化时的处理
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentTab === 'hosts') {
    // 页面重新可见时，检查缓存是否过期
    const now = Date.now()
    if (lastHostsUpdate && (now - lastHostsUpdate >= HOSTS_CACHE_DURATION)) {
      console.log('页面重新可见，缓存已过期，刷新数据')
      loadHosts(true)
    } else if (lastHostsUpdate) {
      // 更新倒计时显示
      updateCountdown()
    }
  }
})

// 每分钟检查一次服务状态
setInterval(() => {
  checkServiceStatus()
}, 60 * 1000) // 每分钟检查一次

// === 增强调试工具和状态监控 ===

// 调试状态管理
const debugState = {
  logs: [],
  maxLogs: 100,
  isEnabled: true,
  startTime: Date.now()
}

// 增强日志记录
function debugLog(level, message, data = null) {
  if (!debugState.isEnabled) return

  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    level,
    message,
    data,
    relativeTime: Date.now() - debugState.startTime
  }

  debugState.logs.push(logEntry)

  // 保持日志数量在限制内
  if (debugState.logs.length > debugState.maxLogs) {
    debugState.logs.shift()
  }

  // 输出到控制台
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
  console[consoleMethod](`[${level.toUpperCase()}] ${message}`, data || '')
}

// 实时状态监控
function createStatusMonitor() {
  const monitor = {
    lastOptimizeTime: null,
    optimizeCount: 0,
    errorCount: 0,
    networkStatus: 'unknown',
    cacheStatus: 'unknown',

    updateOptimizeStatus(success, duration = null) {
      this.lastOptimizeTime = Date.now()
      this.optimizeCount++
      if (!success) this.errorCount++

      debugLog('info', `优选操作${success ? '成功' : '失败'}`, {
        count: this.optimizeCount,
        errors: this.errorCount,
        duration
      })
    },

    updateNetworkStatus(status) {
      this.networkStatus = status
      debugLog('info', `网络状态更新: ${status}`)
    },

    updateCacheStatus(status) {
      this.cacheStatus = status
      debugLog('info', `缓存状态更新: ${status}`)
    },

    getStatus() {
      return {
        ...this,
        uptime: Date.now() - debugState.startTime,
        successRate: this.optimizeCount > 0 ? ((this.optimizeCount - this.errorCount) / this.optimizeCount * 100).toFixed(1) + '%' : 'N/A'
      }
    }
  }

  return monitor
}

const statusMonitor = createStatusMonitor()

// 调试功能：手动清除缓存并重新加载
window.debugClearCache = function() {
  debugLog('info', '手动清除缓存并重新加载')
  forceClearCache()
  statusMonitor.updateCacheStatus('cleared')
  if (currentTab === 'hosts') {
    loadHosts(true)
  }
  console.log('缓存已清除，正在重新加载...')
}

// 调试功能：显示当前缓存状态
window.debugCacheStatus = function() {
  const status = {
    cachedContentLength: cachedHostsContent ? cachedHostsContent.length : null,
    lastUpdate: lastHostsUpdate ? new Date(lastHostsUpdate).toLocaleString() : null,
    localStorageSize: localStorage.getItem('hosts_cache')?.length || null,
    localStorageTimestamp: localStorage.getItem('hosts_cache_timestamp') || null,
    hasAutoRefreshTimer: !!autoRefreshTimer,
    hasCountdownTimer: !!countdownTimerInterval
  }

  if (lastHostsUpdate) {
    const now = Date.now()
    const cacheAge = Math.round((now - lastHostsUpdate) / 60000)
    const timeLeft = Math.round((HOSTS_CACHE_DURATION - (now - lastHostsUpdate)) / 60000)
    status.cacheAgeMinutes = cacheAge
    status.timeLeftMinutes = timeLeft
    status.isExpired = now - lastHostsUpdate >= HOSTS_CACHE_DURATION
  }

  console.log('=== 当前缓存状态 ===', status)
  debugLog('info', '缓存状态查询', status)
  return status
}

// 调试功能：测试API响应
window.debugTestAPI = async function() {
  debugLog('info', '开始API测试')
  const testStart = Date.now()

  const params = new URLSearchParams()
  params.append('optimize', 'true')
  params.append('custom', 'true')
  params.append('refresh', 'true')

  const url = `${baseUrl}/hosts?${params.toString()}&_t=${Date.now()}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    })

    const duration = Date.now() - testStart

    if (response.ok) {
      const content = await response.text()
      const customDomainCount = (content.match(/# Custom Domains|自定义域名/gi) || []).length

      const result = {
        success: true,
        duration,
        length: content.length,
        customDomains: customDomainCount,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      }

      debugLog('info', 'API测试成功', result)
      statusMonitor.updateNetworkStatus('ok')
      return result
    } else {
      const error = `${response.status}: ${response.statusText}`
      debugLog('error', 'API测试失败', { error, duration })
      statusMonitor.updateNetworkStatus('error')
      return { success: false, error, duration }
    }
  } catch (error) {
    const duration = Date.now() - testStart
    debugLog('error', 'API测试异常', { error: error.message, duration })
    statusMonitor.updateNetworkStatus('error')
    return { success: false, error: error.message, duration }
  }
}

// 调试功能：测试优选API
window.debugTestOptimizeAPI = async function() {
  debugLog('info', '开始优选API测试')
  const testStart = Date.now()

  try {
    const response = await fetch(`${baseUrl}/api/optimize-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'main-page-refresh'
      }
    })

    const duration = Date.now() - testStart
    const result = await response.json()

    if (response.ok) {
      debugLog('info', '优选API测试成功', { ...result, duration })
      statusMonitor.updateOptimizeStatus(true, duration)
      return { success: true, ...result, duration }
    } else {
      debugLog('error', '优选API测试失败', { error: result.error, duration })
      statusMonitor.updateOptimizeStatus(false, duration)
      return { success: false, error: result.error, duration }
    }
  } catch (error) {
    const duration = Date.now() - testStart
    debugLog('error', '优选API测试异常', { error: error.message, duration })
    statusMonitor.updateOptimizeStatus(false, duration)
    return { success: false, error: error.message, duration }
  }
}

// 调试功能：获取系统状态
window.debugSystemStatus = function() {
  const status = {
    monitor: statusMonitor.getStatus(),
    cache: window.debugCacheStatus(),
    page: {
      currentTab,
      baseUrl,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      cookieEnabled: navigator.cookieEnabled
    },
    timers: {
      autoRefreshTimer: !!autoRefreshTimer,
      countdownTimerInterval: !!countdownTimerInterval
    },
    logs: debugState.logs.slice(-10) // 最近10条日志
  }

  console.log('=== 系统状态 ===', status)
  return status
}

// 调试功能：导出日志
window.debugExportLogs = function() {
  const logData = {
    exportTime: new Date().toISOString(),
    systemStatus: window.debugSystemStatus(),
    allLogs: debugState.logs
  }

  const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `custom-hosts-debug-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)

  debugLog('info', '调试日志已导出')
}

// 调试功能：清除日志
window.debugClearLogs = function() {
  debugState.logs = []
  debugLog('info', '调试日志已清除')
}

console.log('=== 增强调试功能已加载 ===')
console.log('基础功能:')
console.log('- debugClearCache(): 清除缓存并重新加载')
console.log('- debugCacheStatus(): 查看缓存状态')
console.log('- debugTestAPI(): 测试hosts API响应')
console.log('增强功能:')
console.log('- debugTestOptimizeAPI(): 测试优选API')
console.log('- debugSystemStatus(): 获取完整系统状态')
console.log('- debugExportLogs(): 导出调试日志')
console.log('- debugClearLogs(): 清除调试日志')
console.log('状态监控已启用，所有操作将被记录')

/* ============================================================
 * 本地测速：由浏览器直连目标站点，不经过 Cloudflare 服务器。
 *
 * 原理与限制：
 *   - 浏览器无法指定 IP 连接，只能按系统 DNS 解析结果连接，
 *     因此测的是「当前 DNS 下」的真实往返耗时。
 *   - 若用户已应用本页生成的 hosts，测得的即为应用后的实际体验。
 *   - 用 fetch(mode:'no-cors') 拿不到响应体，但能拿到 timing，
 *     足以测量 RTT；被墙时 fetch 会快速 reject，正好用来判定不通。
 * ============================================================ */

const speedtestState = { running: false, abort: false, results: [] }

// 单次探测：no-cors 请求测总往返耗时。
// 跨域请求拿不到 DNS/TCP/TLS 分阶段数据（需 Timing-Allow-Origin），故只测总耗时。
async function probeOnce(domain, timeoutMs = 6000) {
  const url = `https://${domain}/?_st=${Date.now()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = performance.now()

  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'follow',
    })
    return { ok: true, total: Math.round(performance.now() - t0) }
  } catch (err) {
    return { ok: false, total: Math.round(performance.now() - t0), error: err.name }
  } finally {
    clearTimeout(timer)
  }
}

// 多轮采样：成功样本用于计算最快/中位/抖动，全部失败则判为不通
async function probeDomain(domain, rounds) {
  const samples = []
  let failCount = 0

  for (let i = 0; i < rounds; i++) {
    if (speedtestState.abort) break
    const r = await probeOnce(domain)
    if (r.ok) samples.push(r.total)
    else if (r.error !== 'AbortError') failCount++
    if (i < rounds - 1) await new Promise((res) => setTimeout(res, 120))
  }

  if (samples.length === 0) {
    return { ok: false, best: null, median: null, jitter: null, successRate: 0 }
  }

  samples.sort((a, b) => a - b)
  const best = samples[0]
  const median = samples[Math.floor(samples.length / 2)]
  // 抖动 = 最大与最小之差，反映链路稳定性
  const jitter = samples.length > 1 ? samples[samples.length - 1] - best : 0

  return {
    ok: true,
    best,
    median,
    jitter,
    successRate: Math.round((samples.length / (samples.length + failCount)) * 100),
  }
}

// 并发池：控制同时在跑的探测数量，避免浏览器连接数上限导致互相排队
async function runPool(items, concurrency, worker, onDone) {
  let index = 0
  let done = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (speedtestState.abort) return
      const i = index++
      if (i >= items.length) return
      const result = await worker(items[i], i)
      done++
      onDone(result, done, items.length)
    }
  })
  await Promise.all(runners)
}

function renderSpeedtestRow(item) {
  const tbody = document.getElementById('speedtestBody')
  if (!tbody) return
  const r = item.result
  const latCls = (v) => (v == null ? 'st-dead' : v < 300 ? 'st-good' : v < 800 ? 'st-mid' : 'st-bad')
  const tr = document.createElement('tr')
  tr.innerHTML = `
    <td>${item.domain}</td>
    <td>${item.group || '-'}</td>
    <td class="${latCls(r.best)}">${r.best != null ? r.best + ' ms' : '—'}</td>
    <td>${r.median != null ? r.median + ' ms' : '—'}</td>
    <td>${r.jitter != null ? '±' + r.jitter + ' ms' : '—'}</td>
    <td>${r.successRate}%</td>
    <td class="${r.ok ? 'st-good' : 'st-dead'}">${r.ok ? '可联通' : '不通'}</td>
  `
  tbody.appendChild(tr)
}

async function startSpeedtest() {
  if (speedtestState.running) return

  const btnStart = document.getElementById('startSpeedtest')
  const btnStop = document.getElementById('stopSpeedtest')
  const statusEl = document.getElementById('speedtestStatus')
  const tbody = document.getElementById('speedtestBody')

  speedtestState.running = true
  speedtestState.abort = false
  speedtestState.results = []
  btnStart.disabled = true
  btnStop.disabled = false
  tbody.innerHTML = ''
  document.getElementById('speedtestSummary').style.display = 'none'

  const rounds = Number(document.getElementById('stRounds').value) || 2
  const concurrency = Number(document.getElementById('stConcurrency').value) || 6

  let targets = []
  try {
    const res = await fetch(`${baseUrl}/hosts.json`, { cache: 'no-store' })
    const data = await res.json()

    // 后端按分组返回了各自的域名列表，用来给每条记录标注所属分组
    const groupNameByDomain = {}
    for (const group of (data.groups || [])) {
      for (const [, domain] of (group.entries || [])) {
        groupNameByDomain[domain] = group.name
      }
    }
    for (const [, domain] of (data.custom || [])) {
      groupNameByDomain[domain] = '自定义'
    }

    // entries 是 [ip, domain]，测速只需要域名
    targets = (data.entries || []).map(([, domain]) => ({
      domain,
      group: groupNameByDomain[domain] || '-',
    }))
  } catch (err) {
    statusEl.textContent = '获取域名列表失败：' + err.message
    speedtestState.running = false
    btnStart.disabled = false
    btnStop.disabled = true
    return
  }

  if (!targets.length) {
    statusEl.textContent = '没有可测速的域名，请先刷新 hosts 数据'
    speedtestState.running = false
    btnStart.disabled = false
    btnStop.disabled = true
    return
  }

  statusEl.textContent = `正在测速 0/${targets.length}（${rounds} 轮，并发 ${concurrency}）`

  await runPool(
    targets,
    concurrency,
    async (item) => {
      const result = await probeDomain(item.domain, rounds)
      return { ...item, result }
    },
    (item, done, total) => {
      speedtestState.results.push(item)
      renderSpeedtestRow(item)
      statusEl.textContent = `正在测速 ${done}/${total}（${rounds} 轮，并发 ${concurrency}）`
    }
  )

  // 汇总
  const finished = speedtestState.results
  const okList = finished.filter((x) => x.result.ok)
  const failList = finished.filter((x) => !x.result.ok)
  const latencies = okList.map((x) => x.result.best).sort((a, b) => a - b)

  document.getElementById('stOk').textContent = String(okList.length)
  document.getElementById('stFail').textContent = String(failList.length)
  document.getElementById('stAvg').textContent = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) + ' ms'
    : '-'
  document.getElementById('stBest').textContent = latencies.length ? latencies[0] + ' ms' : '-'
  document.getElementById('speedtestSummary').style.display = 'flex'

  statusEl.textContent = speedtestState.abort
    ? `已停止（完成 ${finished.length}/${targets.length}）`
    : `完成：${okList.length} 可联通 / ${failList.length} 不通`

  speedtestState.running = false
  btnStart.disabled = false
  btnStop.disabled = true
}

function stopSpeedtest() {
  speedtestState.abort = true
  const statusEl = document.getElementById('speedtestStatus')
  if (statusEl) statusEl.textContent = '正在停止...'
}

document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('startSpeedtest')
  const btnStop = document.getElementById('stopSpeedtest')
  if (btnStart) btnStart.addEventListener('click', startSpeedtest)
  if (btnStop) btnStop.addEventListener('click', stopSpeedtest)
})
