from quart import render_template


class PanelManager:
    def __init__(self) -> None:
        self._templates = {
            "home": "index.html",
            "console": "console.html",
        }

    async def render(self, panel_name: str):
        return await render_template(self._templates[panel_name])
