#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

/*
 * Keep this addon on the stable N-API surface without depending on Node's
 * development headers. The symbols are resolved by Node when the addon loads.
 */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);

extern napi_status napi_add_env_cleanup_hook(
    napi_env env, void (*hook)(void *data), void *data);
extern napi_status napi_create_function(
    napi_env env,
    const char *utf8_name,
    size_t length,
    napi_callback callback,
    void *data,
    napi_value *result);
extern napi_status napi_get_cb_info(
    napi_env env,
    napi_callback_info info,
    size_t *argc,
    napi_value *argv,
    napi_value *this_arg,
    void **data);
extern napi_status napi_get_undefined(napi_env env, napi_value *result);
extern napi_status napi_get_value_int32(
    napi_env env, napi_value value, int32_t *result);
extern napi_status napi_set_named_property(
    napi_env env, napi_value object, const char *utf8_name, napi_value value);

static int32_t recorded_exit_code = 0;

static napi_value record_exit_code(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  int32_t code = 0;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == 0 &&
      argc == 1 && napi_get_value_int32(env, argv[0], &code) == 0) {
    recorded_exit_code = code;
  }
  napi_get_undefined(env, &result);
  return result;
}

static void finish_without_platform_teardown(void *data) {
  (void)data;
  _exit(recorded_exit_code);
}

/*
 * process.exit() takes Node's C++ Exit path (platform teardown) which never
 * reaches environment cleanup hooks and hangs under CheerpX 1.3.9. The preload
 * points process.reallyExit at this function so an explicit exit terminates
 * through the same _exit boundary as a natural one, with the exact status.
 * Proven in the real CheerpX VM on 2026-09-02 (smoke probe node-exit-override).
 */
static napi_value exit_now(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  int32_t code = recorded_exit_code;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == 0 && argc == 1) {
    napi_get_value_int32(env, argv[0], &code);
  }
  _exit(code);
  napi_get_undefined(env, &result);
  return result;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value setter;
  napi_value exiter;

  if (napi_add_env_cleanup_hook(env, finish_without_platform_teardown, NULL) !=
      0) {
    return NULL;
  }
  if (napi_create_function(env,
                           "setExitCode",
                           11,
                           record_exit_code,
                           NULL,
                           &setter) != 0) {
    return NULL;
  }
  if (napi_set_named_property(env, exports, "setExitCode", setter) != 0) {
    return NULL;
  }
  if (napi_create_function(env, "exitNow", 7, exit_now, NULL, &exiter) != 0) {
    return NULL;
  }
  if (napi_set_named_property(env, exports, "exitNow", exiter) != 0) {
    return NULL;
  }
  return exports;
}
