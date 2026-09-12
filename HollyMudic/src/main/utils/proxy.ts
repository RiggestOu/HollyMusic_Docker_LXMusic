export const setProxyByHost = (host?: string, port?: string) => {
  // 设置代理
  if (host && port) {
    process.env.HTTP_PROXY = `http://${host}:${port}`
    process.env.HTTPS_PROXY = `http://${host}:${port}`
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
  }
}

export const getProxy = () => {
  const setting = global.lx?.appSetting as LX.AppSetting | undefined
  if (setting?.['network.proxy.enable'] && setting?.['network.proxy.host']) {
    return {
      host: setting['network.proxy.host'],
      port: setting['network.proxy.port'] || '',
    }
  }
  return null
}
