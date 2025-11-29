export function debounce<T extends (...args: any[]) => void>(
    func: T,
    wait: number,
): T {
    let timeout: NodeJS.Timeout;
    return function debounceWrapper(this: unknown, ...args: Parameters<T>) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    } as T;
}
