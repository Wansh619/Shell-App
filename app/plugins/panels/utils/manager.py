from quart import render_template

from app.plugins.panels.models.models import PanelTemplateMap


class PanelManager:
    def __init__(self, template_map: PanelTemplateMap | None = None) -> None:
        self._template_map = template_map or PanelTemplateMap()
        self._templates = self._template_map.templates

    async def render(self, panel_name: str):
        return await render_template(self._template_map.get_template(panel_name))
