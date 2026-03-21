const bump = document.getElementById("bump");
const menus = document.querySelectorAll(".logo-container");

const positionBump = (value) => {
  bump.style.transform = `translateX(${value}px) translateY(-40px)`;
};

const calculateTransformXDiff = (el1, el2) => {
  const rect = el1.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;

  const bumpRect = el2.getBoundingClientRect();
  const bumpCenterX = bumpRect.left + bumpRect.width / 2;

  const transform = window.getComputedStyle(el2).transform;

  const currentX =
    transform !== "none"
      ? parseFloat(transform.split(",")[4])
      : 0;

  const moveX = centerX - bumpCenterX + currentX;

  return moveX;
};
let initMoveX = calculateTransformXDiff(menus[0], bump);
    positionBump(initMoveX);
menus.forEach((menu) => {
  menu.addEventListener("mouseenter", () => {
    const moveX = calculateTransformXDiff(menu, bump);
    positionBump(moveX);
  });
});