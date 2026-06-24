export async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        void setTimeout(resolve, ms);
    });
}
