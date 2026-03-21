const togglebtn = document.getElementById("toggle");

togglebtn.addEventListener('click', (e) => {
    const x = e.clientX;
    const y = e.clientY;
    const endRadius= Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y)
    )

    const transition = document.startViewTransition(() => {
        document.documentElement.classList.toggle("dark")
    })

    transition.ready.then(() => {
        const animation=document.documentElement.animate(
            {
                clipPath: [
                    `circle(0px at ${x}px ${y}px)`,
                    `circle(${endRadius}px at ${x}px ${y}px)`
                ]
            },
            {
                duration: 600,
                easing: "ease-in-out",
                pseudoElement: "::view-transition-new(root)"
            }
        )
          animation.onfinish = () => animation.cancel();

    })
    // document.documentElement.classList.toggle('dark')
})