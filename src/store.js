import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

let Vue // bind on install

export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    // 对于 cdn 加载的 Vue，需要手动调用一次 install
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    if (__DEV__) {
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // store internal state
    // 当前是否正在 commit
    this._committing = false
    // 所有的摊平的 action，包括子 modules
    this._actions = Object.create(null)
    this._actionSubscribers = []
    // 所有的摊平的 mutation，包括子 modules
    this._mutations = Object.create(null)
    // 所有摊平的 getters
    this._wrappedGetters = Object.create(null)

    // 树状结构，通过 _children 关联，如果有子 modules，那么 _children 就会有值
    // _modules.root 指向最上层的 module
    this._modules = new ModuleCollection(options)
    // 摊平的 module 的结构，key 为 module 的 name，value 为对应的 moudle
    this._modulesNamespaceMap = Object.create(null)

    this._subscribers = []
    // store._watcherVm 是一个 Vue 实例
    this._watcherVM = new Vue()
    this._makeLocalGettersCache = Object.create(null)

    // bind commit and dispatch to self
    const store = this
    const { dispatch, commit } = this
    // 为 dispath 和 commit 绑定 this 到 store
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict
    // 最上层的 module 的 state 值
    const state = this._modules.root.state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    // 递归遍历所有的 module，将它们的 mutations、actions、getters 摊平存储到对应的对象中，如果有子 Module，那么 key 会拼接上 module 的 name
    /** key 会被拼接上当前 module 的 name
     * 1. 所有的 actions => store._actions
     * 2. 所有的 mutations => store.__mutations
     * 3. 所有的 getters => store._wrappedGetters
     * 4. 所有的 module 摊平 => store._modulesNamespaceMap
     */
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    resetStoreVM(this, state)

    // apply plugins
    plugins.forEach(plugin => plugin(this))

    const useDevtools = options.devtools !== undefined ? options.devtools : Vue.config.devtools
    if (useDevtools) {
      devtoolPlugin(this)
    }
  }
  // 返回响应式的 state
  get state () {
    return this._vm._data.$$state
  }

  set state (v) {
    if (__DEV__) {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  commit (_type, _payload, _options) {
    // check object-style commit
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })

    this._subscribers
      .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
      .forEach(sub => sub(mutation, this.state))

    if (
      __DEV__ &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    const entry = this._actions[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    try {
      this._actionSubscribers
        .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (__DEV__) {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    return new Promise((resolve, reject) => {
      result.then(res => {
        try {
          this._actionSubscribers
            .filter(sub => sub.after)
            .forEach(sub => sub.after(action, this.state))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in after action subscribers: `)
            console.error(e)
          }
        }
        resolve(res)
      }, error => {
        try {
          this._actionSubscribers
            .filter(sub => sub.error)
            .forEach(sub => sub.error(action, this.state, error))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in error action subscribers: `)
            console.error(e)
          }
        }
        reject(error)
      })
    })
  }

  subscribe (fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  subscribeAction (fn, options) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers, options)
  }

  watch (getter, cb, options) {
    if (__DEV__) {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }
  // 替换 state
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }
  // 新增一个 module
  registerModule (path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }
    // 将新 module 更新到 modules 树中正确的位置
    this._modules.register(path, rawModule)
    // 处理新增 module 中的 actions、mutations、getters、state 等
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    // 重新绑定响应式
    resetStoreVM(this, this.state)
  }

  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    this._modules.unregister(path)
    this._withCommit(() => {
      const parentState = getNestedState(this.state, path.slice(0, -1))
      Vue.delete(parentState, path[path.length - 1])
    })
    resetStore(this)
  }

  hasModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    return this._modules.isRegistered(path)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }
  // 执行 commit, 更新 _committing 标志位
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}
  // reset local getters cache
  store._makeLocalGettersCache = Object.create(null)
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    // direct inline function use will lead to closure preserving oldVm.
    // using partial to return function with only arguments preserved in closure environment.
    // 将 getter 作为 computed，这样能进行依赖收集，当 state 发生改变后能触发 getter 重新执行
    computed[key] = partial(fn, store)
    // 将所有的 getters 也在 store.getters 上定义一遍，能够通过 store.getters.xxx 访问 getter
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  Vue.config.silent = true
  // 在 store._vm 上新建一个实例，将 state 作为 vue 的 data，这样就能通过 store._vm.xxx 访问到 state，并且 state 被转换为 响应式的
  store._vm = new Vue({
    data: {
      // 将 state 转变为响应式的属性
      $$state: state
    },
    // 将 getter 作为 computed，这样能进行依赖收集，当 state 发生改变后能触发 getter 重新执行
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length
  // 把 string[] 类型的 path，拼接为一个字符串 moduleA/moduleB/
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  // 通常来说，我们写子 module 时最好都将 namespaced 置为 true
  if (module.namespaced) {
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    // 简历每个 module 对应的 namespace 路径 => module 的映射
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  // 子 module 会执行该逻辑
  if (!isRoot && !hot) {
    // 拿到 parent module 对应的 state
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    // 如果有子 module，state 是在 store.state 是嵌套的
    store._withCommit(() => {
      if (__DEV__) {
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join('.')}"`
          )
        }
      }
      // 将当前 module 的 state 设置到 parent state 上，这里用的是响应式，保证了当前 module 的 state 是响应式的
      Vue.set(parentState, moduleName, module.state)
    })
  }
  // 每个 module 都有一个 local 处理当前 module 内的 dispatch, commit, getter、state 等，能正确的访问到当前 module 内的响应模块
  const local = module.context = makeLocalContext(store, namespace, path)

  module.forEachMutation((mutation, key) => {
    // 拼接访问当前 mutation 的 key，为当前 module 的 namespace key + mutation key
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    // 拼接访问当前 action 的 key，为当前 module 的 namespace key + action key
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    // 拼接访问当前 getter 的 key，为当前 module 的 namespace key + getter key
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/** 注意下面的注释
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
function makeLocalContext (store, namespace, path) {
  // 如果当前是根 module，那么直接调用根实例上的 store.commit、store.dispatch 方法
  const noNamespace = namespace === ''

  const local = {
    // 包装 dispatch，加上 namespace
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args
      // 拼接 namespace
      // 如果指定了 root 为 true, 那么不拼接 namespace
      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }
      // 重新派发
      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      // 如果指定了 root 为 true, 那么不拼接 namespace
      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      // 重新派发
      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  // 处理访问当前 module 的 getters 和 state
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters // 根 module 的 getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path) // 根据 path，返回当前 module 下的 state
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  // 由于会多次调用 makeLocalGetters，加一个缓存
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

function registerMutation (store, type, handler, local) {
  // 将所有的 mutations 摊平存储到 store._mutations 上
  const entry = store._mutations[type] || (store._mutations[type] = [])
  // 包装 mutations，只接收 payload
  entry.push(function wrappedMutationHandler (payload) {
    // 执行当前 mutation 时，传入当前 module 下的 state，也就是 local.state
    handler.call(store, local.state, payload)
  })
}

function registerAction (store, type, handler, local) {
  // 将所有的 actions 摊平存储到 store._actions 上
  const entry = store._actions[type] || (store._actions[type] = [])
  // 包装 mutations，只接收 payload
  entry.push(function wrappedActionHandler (payload) {
    // 执行当前 action 时，传入当前 module 下的 state，以及包装过的 dispatch、commit、getters
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    // 将函数的返回结果统一包装为 Promise
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

function registerGetter (store, type, rawGetter, local) {
  // 如果已经注册了不需要再注册
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  // 将所有的 getter 摊平存储到 store._wrappedGetters 上
  store._wrappedGetters[type] = function wrappedGetter (store) {
    // 执行用户定义的 getter，并未其传入当前 module 下的 state、getters、全局的 state、getters
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

function enableStrictMode (store) {
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (__DEV__) {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (__DEV__) {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}
// 安装函数
export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    if (__DEV__) {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  // 保存 Vue
  Vue = _Vue
  // 混入钩子函数
  applyMixin(Vue)
}
