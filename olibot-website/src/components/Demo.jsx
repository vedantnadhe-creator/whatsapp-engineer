export default function Demo() {
  return (
    <section id="demo" className="pb-20">
      <div className="max-w-narrow mx-auto px-6">
        <div className="border border-border rounded-lg overflow-hidden bg-black">
          <video
            controls
            preload="metadata"
            className="w-full block"
          >
            <source
              src="https://bmv2bqg5gpcd.compat.objectstorage.ap-mumbai-1.oraclecloud.com/pl-uat-public-docs/videos/olibot-video.mp4"
              type="video/mp4"
            />
          </video>
        </div>
      </div>
    </section>
  )
}
