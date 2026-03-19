# EMQX (Docker)

## 启动

```bash
docker compose up -d
```

## Dashboard

- 地址: `http://localhost:18083`
- 账号/密码: `admin` / `admin`

## 创建 MQTT 用户（用于客户端连接）

> 只需要执行一次。这里创建用户名/密码都是 `admin`。

```bash
docker exec -it emqx emqx ctl users add admin admin
```

之后你的 MQTT 客户端用：

- username: `admin`
- password: `admin`

连接 `mqtt://localhost:1883` 即可。

