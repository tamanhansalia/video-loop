import React from 'react'

const LoadingSpinner = () => {
  return (
    <div className="flex justify-center items-center">
      <div className="relative">
        <div className="w-12 h-12 border-4 border-gray-700 border-t-purple-500 rounded-full animate-spin"></div>
        <div className="w-12 h-12 border-4 border-transparent border-r-pink-500 rounded-full animate-spin absolute top-0 left-0" style={{ animationDirection: 'reverse', animationDuration: '0.6s' }}></div>
      </div>
    </div>
  )
}

export default LoadingSpinner
