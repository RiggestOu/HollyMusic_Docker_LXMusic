export const initHotKey = async () => {
  return {
    local: { enable: false, keys: {} },
    global: { enable: false, keys: {} },
  }
}

export const initSetting = async () => {
  return {
    setting: {
      'common.apiSource': '',
      'common.sourceNameType': 'real' as const,
      'network.proxy.enable': false,
      'network.proxy.host': '',
      'network.proxy.port': '',
      'player.volume': 0.5,
      'player.isMute': false,
    }
  }
}
