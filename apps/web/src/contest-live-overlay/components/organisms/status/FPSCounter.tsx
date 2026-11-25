import { useEffect, useState } from "react";

export const FPSCounter = () => {
    const [fps, setFps] = useState<string>();
    useEffect(() => {
        let startTime = performance.now();
        let frame = 0;
        let handle: number;

        const tick: FrameRequestCallback = (time) => {
            frame++;
            if (time - startTime > 1000) {
                setFps((frame / ((time - startTime) / 1000)).toFixed(1));
                startTime = time;
                frame = 0;
            }
            handle = window.requestAnimationFrame(tick);
        };
        handle = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(handle);
    }, []);
    return <div>Frames made last second: {fps}</div>;
};
