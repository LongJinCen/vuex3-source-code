export default function (Vue) {
  const version = Number(Vue.version.split('.')[0])
  // 只看 version >= 2 就行
  if (version >= 2) {
    // 为每个组件混入 beforeCreate 钩子
    Vue.mixin({ beforeCreate: vuexInit })
  } else {
    // override init and inject vuex init procedure
    // for 1.x backwards compatibility.
    const _init = Vue.prototype._init
    Vue.prototype._init = function (options = {}) {
      options.init = options.init
        ? [vuexInit].concat(options.init)
        : vuexInit
      _init.call(this, options)
    }
  }

  /**
   * Vuex init hook, injected into each instances init hooks list.
   */

  function vuexInit () {
    // 拿到当前组价年的 options
    const options = this.$options
    // store injection
    // 只有根 new Vue 实例才会有 store
    if (options.store) {
      // 将 store 挂载到 Vue 实例上
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    // 对于子组件，也需要挂载 $store 到实例上
    } else if (options.parent && options.parent.$store) {
      // 统一都是取的根 Vue 实例上的 store
      this.$store = options.parent.$store
    }
  }
}
