import asyncio
from dataclasses import is_dataclass
from pathlib import Path

import pytest
from quart import Blueprint

from app import create_app
from app.core.plugins import Plugin, PluginManager, initialize_plugins, register_plugins
from app.plugins import (
    CPUStatsPlugin,
    ConsolePlugin,
    NetworkManagerPlugin,
    PanelsPlugin,
    TerminalPlugin,
)
from app.plugins.console.models.models import (
    ConsoleErrorPayload,
    ConsoleMessage,
    ConsoleOutputPayload,
    ConsoleReadyPayload,
    EditorViewModel,
    ImageViewModel,
    SessionResponse,
    SkillPayload,
    SkillResultPayload,
    TerminalErrorPayload,
    TerminalMessage,
    TerminalOutputPayload,
    TerminalReadyPayload,
)
from app.plugins.console.skills import Skill, SkillRegistry
from app.plugins.cpu_stats.models.models import (
    CPUSnapshot,
    CompactCPUSample,
    MemoryMetrics,
)
from app.plugins.network_manager.models.models import (
    CompactNetworkSample,
    InterfaceSnapshot,
    NormalizedAddress,
    OperationRecord,
)
from app.plugins.panels.models.models import LogUpdate, PanelTemplateMap


class ExamplePlugin:
    name = "example"

    def register(self, app):
        routes = Blueprint("example_plugin", __name__)

        @routes.get("/example")
        async def example():
            return {"plugin": "example"}

        app.register_blueprint(routes)


def test_app_registers_plugins_and_preserves_core_routes():
    application = create_app(plugins=[ExamplePlugin()])

    async def request_routes():
        async with application.test_client() as client:
            health = await client.get("/health")
            plugins = await client.get("/internal/plugins")
            example = await client.get("/example")
            home = await client.get("/")

        assert health.status_code == 200
        assert await health.get_json() == {"status": "ok"}
        assert await plugins.get_json() == {
            "plugins": ["console", "panels", "cpu_stats", "network_manager", "example"]
        }
        assert example.status_code == 200
        assert await example.get_json() == {"plugin": "example"}
        assert home.status_code == 200
        homepage = await home.get_data(as_text=True)
        assert "<title>Nave Black Hat</title>" in homepage
        assert "images/favicon.svg" in homepage
        assert "css/monitoring.css" in homepage

    asyncio.run(request_routes())


def test_monitoring_dashboard_assets_are_served():
    application = create_app()

    async def request_assets():
        client = application.test_client()
        for path in (
            "/static/js/plugins/cpu_stats/plugin.js",
            "/static/js/plugins/network_manager/plugin.js",
            "/static/css/monitoring.css",
            "/static/images/cpu.svg",
            "/static/images/network.svg",
        ):
            response = await client.get(path)
            assert response.status_code == 200, path
        response = await client.get("/static/js/honeycomb.js")
        source = await response.get_data(as_text=True)
        assert "new CPUStatsPlugin()" in source
        assert "new NetworkManagerPlugin()" in source

    asyncio.run(request_assets())


def test_log_route_preserves_unknown_log_precedence():
    application = create_app()

    async def request_routes():
        async with application.test_client() as client:
            unknown = await client.get("/logs/unknown?offset=not-a-number")
            invalid_offset = await client.get("/logs/error?offset=-1")

        assert unknown.status_code == 404
        assert await unknown.get_json() == {"error": "Unknown log file."}
        assert invalid_offset.status_code == 400
        assert await invalid_offset.get_json() == {"error": "Invalid log offset."}

    asyncio.run(request_routes())


def test_core_plugin_base_dataclass_and_manager_lifecycle():
    base_plugin = Plugin(name="custom", version="2.1.0")
    assert is_dataclass(Plugin)
    assert base_plugin.name == "custom"
    assert base_plugin.version == "2.1.0"
    assert base_plugin.register(None) is None

    manager = PluginManager()
    register_plugins(manager, [base_plugin])
    assert manager.plugin_names == ("custom",)
    assert manager.get_plugin("custom") is base_plugin
    assert manager.plugins == (base_plugin,)

    with pytest.raises(ValueError, match="must not be empty"):
        manager.register(Plugin(name="   "))
    with pytest.raises(ValueError, match="already registered"):
        manager.register(Plugin(name="custom"))


@pytest.mark.parametrize(
    "plugin_cls,expected_name",
    [
        (PanelsPlugin, "panels"),
        (ConsolePlugin, "console"),
        (TerminalPlugin, "console"),
        (CPUStatsPlugin, "cpu_stats"),
        (NetworkManagerPlugin, "network_manager"),
    ],
)
def test_all_builtin_plugins_follow_standardized_structure_and_base_class(
    plugin_cls, expected_name
):
    instance = plugin_cls()
    assert is_dataclass(plugin_cls)
    assert issubclass(plugin_cls, Plugin)
    assert isinstance(instance, Plugin)
    assert instance.name == expected_name
    assert instance.version == "1.0.0"

    plugin_dir = (
        Path(__file__).resolve().parents[1] / "app" / "plugins" / expected_name
    )
    assert (plugin_dir / "__init__.py").is_file()
    assert (plugin_dir / "plugin.py").is_file()
    assert (plugin_dir / "models" / "__init__.py").is_file()
    assert (plugin_dir / "models" / "models.py").is_file()
    assert (plugin_dir / "utils" / "__init__.py").is_file()


def test_all_plugin_models_use_dataclasses():
    for model_cls in (
        LogUpdate,
        PanelTemplateMap,
        ConsoleMessage,
        TerminalMessage,
        SessionResponse,
        ConsoleOutputPayload,
        TerminalOutputPayload,
        ConsoleReadyPayload,
        TerminalReadyPayload,
        ConsoleErrorPayload,
        TerminalErrorPayload,
        SkillPayload,
        SkillResultPayload,
        EditorViewModel,
        ImageViewModel,
        Skill,
        CPUSnapshot,
        CompactCPUSample,
        MemoryMetrics,
        NormalizedAddress,
        InterfaceSnapshot,
        CompactNetworkSample,
        OperationRecord,
    ):
        assert is_dataclass(model_cls), f"{model_cls.__name__} must be a dataclass"

    log_update = LogUpdate(content="ok", offset=2, generation="1:2", reset=False)
    assert log_update.to_dict() == {
        "content": "ok",
        "offset": 2,
        "generation": "1:2",
        "reset": False,
    }
    session_resp = SessionResponse(
        session_id="s1", created_at="2026-01-01T00:00:00Z", status="active"
    )
    assert session_resp.to_dict() == {
        "session_id": "s1",
        "created_at": "2026-01-01T00:00:00Z",
        "status": "active",
    }


def test_console_skills_registry_and_http_dispatch():
    class EchoSkill(Skill):
        def __init__(self):
            super().__init__(
                name="echo",
                panel_state="editor panel",
                description="Echo test skill",
            )

        async def execute(
            self,
            session_id: str,
            args: str = "",
            action: str = "read",
            content: str | None = None,
            cwd: str | None = None,
        ) -> SkillResultPayload:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state=self.panel_state,
                status="ok",
                data={"args": args, "action": action, "content": content, "cwd": cwd},
                message="Echoed",
            )

    registry = SkillRegistry()
    registry.register(EchoSkill())

    application = Quart_app = create_app()
    # Verify default endpoints on application
    async def check_endpoints():
        async with Quart_app.test_client() as client:
            skills_resp = await client.get("/console/skills")
            assert skills_resp.status_code == 200
            skills_data = await skills_resp.get_json()
            assert "skills" in skills_data
            assert isinstance(skills_data["skills"], list)

            unknown_resp = await client.post(
                "/console/skills/nonexistent",
                json={"session_id": "s1", "action": "read", "args": "foo.txt"},
            )
            assert unknown_resp.status_code == 400
            unknown_json = await unknown_resp.get_json()
            assert unknown_json["status"] == "error"
            assert unknown_json["panel_state"] == "terminal"
            assert "Unknown skill" in unknown_json["message"]

        result = await registry.execute("echo", session_id="s1", args="test.py")
        assert result.status == "ok"
        assert result.panel_state == "editor panel"
        assert result.data["args"] == "test.py"

    asyncio.run(check_endpoints())
