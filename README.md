# 贝翰战略咨询 ADAPT 采购评估工作台

ADAPT 帮助采购团队对比供应商、分析权重变化对排名的影响，并将负责人确认的评估版本归档为采购评审报告。

创作者 **Yanbing Min** · 贝翰战略咨询

## 工作流程

1. 下载 Excel 模板，在「供应商数据」工作表填写比较数据。也可导入 `.xlsx`、`.csv` 或 `.tsv` 文件。
2. 新建评估，核对供应商名称、指标方向和权重，生成综合评分与排名。
3. 检查准入条件，选择供应商进行对比，按需保存权重方案。
4. 填写推荐供应商和选择依据，提交负责人复核。
5. 负责人确认后，从「复核与归档」直接下载对应版本的 A4 PDF。

项目支持成员权限、操作记录和结果导出。界面可切换简体中文和 English。项目数据保存在本地运行实例的 SQLite 数据库。

## 本地启动

需要 Node.js 24 或更新版本。本地启动使用 Node.js 自带的 SQLite，无需安装 npm 依赖。在项目根目录运行以下命令，按提示输入至少 12 个字符的管理员初始密码。

```sh
export ADAPT_BOOTSTRAP_OWNER_EMAIL=admin@example.invalid
export ADAPT_PASSWORD_PEPPER="$(openssl rand -hex 32)"
printf '管理员初始密码：'
IFS= read -rs ADAPT_BOOTSTRAP_PASSWORD
printf '\n'
export ADAPT_BOOTSTRAP_PASSWORD
node scripts/start.mjs
```

浏览器打开 `http://127.0.0.1:3000`，使用用户名 `admin` 和配置的密码登录。首次登录直接进入工作台。端口可通过 `PORT` 配置，数据库默认位于 `.data/adapt.sqlite`，整个 `.data/` 目录已列入 `.gitignore`。

生成的 `ADAPT_PASSWORD_PEPPER` 用于后续启动同一个数据库。请将它保存在系统的私有环境变量或密钥存储中。工作台数据库中已有管理员时，仅需提供原有 `ADAPT_PASSWORD_PEPPER` 即可再次启动。

本地运行入口监听 `127.0.0.1`。浏览器和服务需运行在同一台机器上。

## 验证

```sh
node --test tests/*.test.mjs
```

- [使用手册](docs/USER-GUIDE.md)
- [演示流程](docs/DEMO.md)
- [项目与技术说明](docs/PROJECT.md)
- [测试报告](docs/TEST-REPORT.md)
- [发布维护](docs/RELEASE.md)
- [版本记录](CHANGELOG.md)

- [第三方组件许可](THIRD_PARTY_NOTICES.md)
