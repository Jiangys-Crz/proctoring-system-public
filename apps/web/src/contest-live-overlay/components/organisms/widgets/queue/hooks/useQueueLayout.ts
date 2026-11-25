import { useState, useCallback } from "react";

export function useQueueLayout(initialHeight?: number) {
    const [height, setHeight] = useState<number | undefined>(initialHeight);
    const [headerWidth, setHeaderWidth] = useState<number>(0);

    const handleHeaderRef = useCallback((el: HTMLElement | null) => {
        if (el != null) {
            setHeaderWidth(el.offsetWidth);
        }
    }, []);

    const handleRowsContainerRef = useCallback((el: HTMLElement | null) => {
        if (el != null) {
            setHeight(el.offsetHeight);
        }
    }, []);

    return {
        height,
        headerWidth,
        handleHeaderRef,
        handleRowsContainerRef,
    };
}
