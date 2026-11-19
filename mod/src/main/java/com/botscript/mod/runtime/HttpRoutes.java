package com.botscript.mod.runtime;

import java.util.List;

/** 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs` */
public final class HttpRoutes {
    private HttpRoutes() {}

    public record Route(String method, String path, String operationId) {}

    public static final String OPENAPI_VERSION = "1.0.0";

    public static final List<Route> ROUTES = List.of(
            new Route("GET", "/state", "getState"),
            new Route("GET", "/params", "getParams"),
            new Route("POST", "/params", "postParams"),
            new Route("POST", "/pause", "postPause"),
            new Route("POST", "/resume", "postResume"),
            new Route("POST", "/eval", "postEval"),
            new Route("POST", "/event", "postEvent"),
            new Route("POST", "/session", "postSession"),
            new Route("GET", "/tasks", "getTasks"),
            new Route("POST", "/tasks/cancel", "postTasksCancel"),
            new Route("GET", "/logs", "getLogs"),
            new Route("GET", "/stream", "getStream"),
            new Route("POST", "/chat", "postChat"),
            new Route("GET", "/persist", "getPersist"),
            new Route("GET", "/caps", "getCaps")
    );
}
