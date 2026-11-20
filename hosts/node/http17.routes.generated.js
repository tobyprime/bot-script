// 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs`
export const OPENAPI_VERSION = "1.0.0";
export const ROUTES = [
  { method: "GET", path: "/state", operationId: "getState" },
  { method: "GET", path: "/params", operationId: "getParams" },
  { method: "POST", path: "/params", operationId: "postParams" },
  { method: "POST", path: "/pause", operationId: "postPause" },
  { method: "POST", path: "/resume", operationId: "postResume" },
  { method: "POST", path: "/reload", operationId: "postReload" },
  { method: "POST", path: "/eval", operationId: "postEval" },
  { method: "POST", path: "/event", operationId: "postEvent" },
  { method: "POST", path: "/session", operationId: "postSession" },
  { method: "GET", path: "/tasks", operationId: "getTasks" },
  { method: "POST", path: "/tasks/cancel", operationId: "postTasksCancel" },
  { method: "GET", path: "/logs", operationId: "getLogs" },
  { method: "GET", path: "/stream", operationId: "getStream" },
  { method: "POST", path: "/chat", operationId: "postChat" },
  { method: "GET", path: "/persist", operationId: "getPersist" },
  { method: "GET", path: "/caps", operationId: "getCaps" },
];
