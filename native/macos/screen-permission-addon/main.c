#include <CoreGraphics/CoreGraphics.h>
#include <node_api.h>

static napi_value boolean_result(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value check_permission(napi_env env, napi_callback_info info) {
  return boolean_result(env, CGPreflightScreenCaptureAccess());
}

static napi_value request_permission(napi_env env, napi_callback_info info) {
  return boolean_result(env, CGRequestScreenCaptureAccess());
}

NAPI_MODULE_INIT() {
  napi_value check;
  napi_value request;
  napi_create_function(env, "check", NAPI_AUTO_LENGTH, check_permission, NULL, &check);
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, request_permission, NULL, &request);
  napi_set_named_property(env, exports, "check", check);
  napi_set_named_property(env, exports, "request", request);
  return exports;
}
