package io.github.heejoonkwon.flowline;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

public final class WebServer {
    private static final int MAX_REQUEST_SIZE = 1024 * 1024;
    private static final String JSON = "application/json";
    private static final String UTF_8 = "; charset=utf-8";
    private static final JsonMapper MAPPER = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .build();

    record Request(List<TaskScheduler.Task> tasks, List<ResourceScheduler.Resource> resources) {}
    record Response(@JsonUnwrapped TaskScheduler.Schedule dependencies, ResourceScheduler.Plan optimized) {}
    record Asset(String contentType, byte[] content) {}

    public static void main(String[] args) throws IOException {
        String host = System.getenv().getOrDefault("HOST", "127.0.0.1");
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));

        Asset index = asset("index.html", "text/html");
        Map<String, Asset> assets = Map.of(
                "/", index, "/index.html", index,
                "/styles.css", asset("styles.css", "text/css"),
                "/app.js", asset("app.js", "text/javascript"),
                "/graph.js", asset("graph.js", "text/javascript"),
                "/favicon.ico", asset("favicon.ico", "image/x-icon"));
        ResourceScheduler scheduler = new ResourceScheduler();
        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.createContext("/", exchange -> {
            try (exchange) {
                String path = exchange.getRequestURI().getPath();
                if (path.equals("/api/schedule")) {
                    analyze(exchange, scheduler);
                } else if (assets.containsKey(path)) {
                    serveAsset(exchange, assets.get(path));
                } else {
                    error(exchange, 404, "요청한 주소를 찾을 수 없습니다.");
                }
            }
        });
        server.start();
        System.out.printf("Server listening at http://%s:%d%n", host, server.getAddress().getPort());
    }

    private static Asset asset(String name, String contentType) throws IOException {
        try (InputStream input = WebServer.class.getResourceAsStream("/web/" + name)) {
            if (input == null) {
                throw new IOException("Missing web resource: " + name);
            }
            return new Asset(contentType, input.readAllBytes());
        }
    }

    private static void serveAsset(HttpExchange exchange, Asset asset) throws IOException {
        String method = exchange.getRequestMethod();
        if (!method.equals("GET") && !method.equals("HEAD")) {
            exchange.getResponseHeaders().set("Allow", "GET, HEAD");
            error(exchange, 405, "지원하지 않는 요청 방식입니다.");
            return;
        }
        send(exchange, 200, asset.contentType(), asset.content());
    }

    private static void analyze(HttpExchange exchange, ResourceScheduler scheduler) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            exchange.getResponseHeaders().set("Allow", "POST");
            error(exchange, 405, "POST 방식으로 작업 목록을 전송하세요.");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.split(";", 2)[0].trim().equalsIgnoreCase(JSON)) {
            error(exchange, 415, "요청 형식은 application/json이어야 합니다.");
            return;
        }

        byte[] body = exchange.getRequestBody().readNBytes(MAX_REQUEST_SIZE + 1);
        if (body.length > MAX_REQUEST_SIZE) {
            error(exchange, 413, "작업 목록이 너무 큽니다.");
            return;
        }
        try {
            Request request = MAPPER.readValue(body, Request.class);
            if (request == null) {
                throw new IllegalArgumentException("작업 목록을 입력하세요.");
            }
            ResourceScheduler.Analysis analysis = scheduler.schedule(request.tasks(), request.resources());
            send(exchange, 200, JSON, MAPPER.writeValueAsBytes(new Response(analysis.dependencies(), analysis.optimized())));
        } catch (JsonProcessingException e) {
            error(exchange, 400, "작업 목록의 JSON 형식이 올바르지 않습니다. 작업 번호와 시간은 정수로 입력하세요.");
        } catch (IllegalArgumentException e) {
            error(exchange, 400, e.getMessage());
        } catch (IllegalStateException | LinkageError e) {
            System.getLogger(WebServer.class.getName()).log(System.Logger.Level.ERROR, "Schedule analysis failed", e);
            error(exchange, 500, "일정 계산을 완료하지 못했습니다.");
        }
    }

    private static void error(HttpExchange exchange, int status, String message) throws IOException {
        send(exchange, status, JSON, MAPPER.writeValueAsBytes(Map.of("error", message)));
    }

    private static void send(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", contentType.startsWith("image/") ? contentType : contentType + UTF_8);
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.getResponseHeaders().set("Content-Security-Policy",
                "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        if (exchange.getRequestMethod().equals("HEAD")) {
            exchange.getResponseHeaders().set("Content-Length", Integer.toString(body.length));
            exchange.sendResponseHeaders(status, -1);
        } else {
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
        }
    }
}
