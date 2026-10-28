// Prints far more than a pipe buffer holds, so a reader that falls behind exerts backpressure on `nargo test`.
#[test]
unconstrained fn prints_more_than_a_pipe_buffer() {
    for i in 0..3000 {
        println(f"payload line {i}: padding that makes the output outgrow a pipe buffer");
    }
}
